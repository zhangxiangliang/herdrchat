import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { compareVersions, installKind, keptRunning, update } from '../lib/core/update.mjs';
import { createUpdater } from '../lib/core/updater.mjs';
import { placesOfHooks, refreshHook } from '../lib/core/hooks.mjs';

// A made-up npm global folder with herdrchat <version> in it; `run` stands for npm and npx.
function npmHome(version = '1.0.0', { latest = '1.1.0', installFails = false, skill = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdrchat-update-test-'));
  const global = path.join(dir, 'lib', 'node_modules');
  const root = path.join(global, 'herdrchat');
  fs.mkdirSync(root, { recursive: true });
  const setVersion = (v) => fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'herdrchat', version: v }));
  setVersion(version);
  const calls = [];
  const run = async (cmd, args) => {
    const line = [cmd, ...args].join(' ');
    calls.push(line);
    if (line === 'npm root -g') return { ok: true, out: global };
    if (line === 'npm view herdrchat version') return { ok: true, out: latest };
    if (line.startsWith('npm install -g herdrchat@')) {
      if (installFails) return { ok: false, out: 'npm ERR! code EACCES\nnpm ERR! permission denied' };
      setVersion(line.split('@').pop());
      return { ok: true, out: 'changed 1 package' };
    }
    if (line === 'npx -y skills ls -g') return { ok: true, out: skill ? 'herdrchat  ~/.agents/skills/herdrchat' : 'other-skill' };
    if (line.startsWith('npx -y skills update')) return { ok: true, out: 'updated' };
    return { ok: false, out: `unexpected: ${line}` };
  };
  return { dir, root, run, calls, setVersion, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('versions compare as numbers, not as words', () => {
  assert.ok(compareVersions('1.10.0', '1.9.9') > 0);
  assert.equal(compareVersions('1.10.2', '1.10.2'), 0);
  assert.ok(compareVersions('1.2.0', '1.10.0') < 0);
});

test('only a copy npm installed globally is updated; a checkout says to pull', async () => {
  const h = npmHome();
  assert.equal(await installKind(h.root, h.run), 'npm');
  assert.equal(await installKind(path.join(h.dir, 'elsewhere'), h.run), 'other');
  fs.mkdirSync(path.join(h.root, '.git'));
  assert.equal(await installKind(h.root, h.run), 'checkout');
  const r = await update({ root: h.root, run: h.run });
  assert.equal(r.ok, false);
  assert.match(r.lines[0], /git checkout.*git pull/);
  assert.ok(!h.calls.some((c) => c.startsWith('npm install')), 'nothing installed');
  h.done();
});

test('an update installs the latest with npm, refreshes the hook and updates the skill', async () => {
  const h = npmHome('1.0.0', { latest: '1.1.0' });
  const r = await update({ root: h.root, run: h.run, refreshHook: () => 'The hook is refreshed: x' });
  assert.equal(r.ok, true);
  assert.equal(r.version, '1.1.0');
  assert.equal(r.changed, true);
  assert.deepEqual(r.lines, ['herdrchat 1.0.0 → 1.1.0.', 'The hook is refreshed: x', 'The skill is updated.']);
  assert.ok(h.calls.includes('npm install -g herdrchat@1.1.0'));
  h.done();
});

test('an update can go back to an older version, and says when there is nothing to do or it failed', async () => {
  const h = npmHome('1.1.0', { skill: false });
  const back = await update({ root: h.root, run: h.run, version: '1.0.0' });
  assert.equal(back.lines[0], 'herdrchat 1.1.0 → 1.0.0 (back to an older one).');
  assert.match(back.lines.at(-1), /not installed with npx skills/);
  const same = await update({ root: h.root, run: h.run, version: '1.0.0' });
  assert.match(same.lines[0], /already installed/);
  assert.equal(same.changed, false);
  assert.match((await update({ root: h.root, run: h.run, version: 'newest' })).lines[0], /not a version/);
  h.done();
  const f = npmHome('1.0.0', { installFails: true });
  const failed = await update({ root: f.root, run: f.run });
  assert.equal(failed.ok, false);
  assert.match(failed.lines.join('\n'), /permission denied/, 'npm\'s own words, for what to do');
  f.done();
});

test('a bot knows whether something starts it again: its service or start\'s loop', () => {
  assert.equal(keptRunning({ XPC_SERVICE_NAME: 'app.herdrchat.default' }), true);
  assert.equal(keptRunning({ INVOCATION_ID: 'abc' }), true);
  assert.equal(keptRunning({ HERDRCHAT_KEPT: '1' }), true);
  assert.equal(keptRunning({ XPC_SERVICE_NAME: 'com.apple.Terminal' }), false, 'run by hand in a terminal');
});

// The bot's side, on a made-up chat and store.
function bot(h, { env = { HERDRCHAT_KEPT: '1' }, state = {} } = {}) {
  let kept = { ...state };
  const told = [];
  const exits = [];
  const quiet = () => {};
  const updater = createUpdater({ root: h.root, store: { read: () => ({ ...kept }), write: (s) => { kept = s; } }, chat: { tellOwner: async (look) => { told.push(look); } }, log: quiet, logWarn: quiet, logError: quiet, run: h.run, env, exit: (code) => exits.push(code) });
  return { updater, told, exits, state: () => kept };
}

test('a bot says when it runs a new version, but not the first time it runs', async () => {
  const h = npmHome('1.1.0');
  const first = bot(h);
  await first.updater.announce();
  assert.equal(first.told.length, 0);
  const next = bot(h, { state: { ranVersion: '1.0.0' } });
  await next.updater.announce();
  assert.match(next.told[0].markdown, /herdrchat is now 1\.1\.0 \(was 1\.0\.0\)/);
  assert.equal(next.state().ranVersion, '1.1.0');
  h.done();
});

test('new code on disk: a kept bot starts again on it; one run by hand says so, once', async () => {
  const h = npmHome('1.0.0');
  const kept = bot(h);
  const byHand = bot(h, { env: {} });
  await kept.updater.checkCode();
  assert.deepEqual(kept.exits, [], 'nothing new yet');
  h.setVersion('1.1.0');
  await kept.updater.checkCode();
  assert.deepEqual(kept.exits, [0]);
  await byHand.updater.checkCode();
  await byHand.updater.checkCode();
  assert.deepEqual(byHand.exits, [], 'never stops: nothing would start it again');
  assert.equal(byHand.told.length, 1);
  assert.match(byHand.told[0].markdown, /herdrchat start/);
  h.done();
});

test('a newer version on npm is offered once, with a button; the button updates and says how it went', async () => {
  const h = npmHome('1.0.0', { latest: '1.1.0' });
  const b = bot(h);
  await b.updater.offer();
  await b.updater.offer();
  assert.equal(b.told.length, 1, 'once per version');
  assert.deepEqual(b.told[0].buttons, [{ label: 'Update to 1.1.0', value: { update: '1.1.0' } }]);
  const out = b.updater.actions.update({ update: '1.1.0' });
  assert.match(out.toast.text, /Updating to 1\.1\.0/);
  assert.equal(out.card.kind, 'done');
  assert.match(b.updater.actions.update({ update: '1.1.0' }).toast.text, /Already/);
  for (let i = 0; i < 50 && b.exits.length === 0; i += 1) await new Promise((ok) => setTimeout(ok, 5));
  assert.match(b.told.at(-1).title, /1\.1\.0 installed/);
  assert.deepEqual(b.exits, [0], 'and it starts again on it');
  const same = bot(npmHome('1.1.0', { latest: '1.1.0' }));
  await same.updater.offer();
  assert.equal(same.told.length, 0, 'nothing newer: nothing said');
  h.done();
});

test('after an update the agents\' copy of the hook is replaced when it differs; their settings are left alone', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdrchat-hooks-refresh-'));
  const places = placesOfHooks({}, dir);
  assert.equal(refreshHook(places), null, 'no hook in: nothing');
  fs.mkdirSync(path.dirname(places.hook), { recursive: true });
  fs.writeFileSync(places.hook, '# an older hook');
  assert.match(refreshHook(places), /refreshed/);
  assert.equal(refreshHook(places), null, 'the same now: nothing');
  fs.rmSync(dir, { recursive: true, force: true });
});
