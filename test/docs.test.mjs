import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// What a user reads must lead somewhere real: every relative link and #anchor in the
// docs exists, and every `herdrchat <command>` they show is one the command line has.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = ['README.md', 'README.zh.md', 'CONTRIBUTING.md', 'config.env.example', ...fs.readdirSync(path.join(ROOT, 'docs')).map((f) => `docs/${f}`), 'skills/herdrchat/SKILL.md', ...fs.readdirSync(path.join(ROOT, 'skills/herdrchat/references')).map((f) => `skills/herdrchat/references/${f}`)];
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

// GitHub's anchor for a heading: lower case, spaces to dashes, most punctuation dropped
const anchorOf = (heading) => heading.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s/g, '-');
const anchorsIn = (file) => new Set(read(file).split('\n').filter((l) => /^#{1,6} /.test(l)).map((l) => anchorOf(l.replace(/^#+ /, ''))));

test('every relative link and anchor in the docs leads somewhere', () => {
  const broken = [];
  for (const file of DOCS) {
    for (const [, target] of read(file).matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^(https?:|mailto:)/.test(target)) continue;
      const [rel, anchor] = target.split('#');
      const dest = rel ? path.normalize(path.join(path.dirname(file), rel)) : file;
      if (!fs.existsSync(path.join(ROOT, dest))) broken.push(`${file}: ${target} (no ${dest})`);
      else if (anchor && dest.endsWith('.md') && !anchorsIn(dest).has(anchor)) broken.push(`${file}: ${target} (no heading #${anchor} in ${dest})`);
    }
  }
  assert.deepEqual(broken, []);
});

test('every herdrchat command the docs show is one the command line has', () => {
  const usage = read('bin/cli.mjs').match(/const USAGE = `([\s\S]*?)`;/)[1];
  const commands = new Set([...usage.matchAll(/^ {2}([a-z]+) /gm)].map((m) => m[1]));
  assert.ok(commands.has('init') && commands.has('install'), 'the usage lists the commands');
  const unknown = [];
  for (const file of DOCS) {
    for (const [, word] of read(file).matchAll(/`herdrchat ([a-z][a-z-]*)/g)) {
      if (!commands.has(word)) unknown.push(`${file}: herdrchat ${word}`);
    }
  }
  assert.deepEqual([...new Set(unknown)], []);
});
