import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';

// `npx skills add` and every agent read the skill's front matter as YAML: a header that
// does not parse means the skill cannot be installed at all.
test('the skill\'s front matter parses as YAML, with a name and a description', () => {
  const text = fs.readFileSync(new URL('../skills/herdrchat/SKILL.md', import.meta.url), 'utf8');
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(m, 'SKILL.md starts with a --- front matter block');
  const meta = parse(m[1]);
  assert.equal(meta.name, 'herdrchat');
  assert.equal(typeof meta.description, 'string');
  assert.match(meta.description, /Feishu/);
  assert.ok(meta.description.length > 50 && meta.description.length < 1024, `description of ${meta.description.length} characters`);
});
