import assert from 'node:assert/strict';
import test from 'node:test';
import { asked, branchOf, footerWords, forgetAll, knownSoon, lastKnown, tokens, windowName } from '../lib/core/meter.mjs';

test('the footer says what is known, in the status line\'s words, and leaves out what is not', () => {
  assert.equal(footerWords({ app: 'claude', model: 'claude-opus-5-5', branch: 'main', context: { used: 234480, size: 1e6 }, limits: [{ name: '5-hour', used: 2 }, { name: '7-day', used: 56.6 }] }),
    'claude · claude-opus-5-5 · main · context 23% (234k) · 5-hour 2% · 7-day 57%');
  assert.equal(footerWords({ app: 'codex', model: 'gpt-x', screen: true }), 'codex · screen', 'read off the screen: no model claimed');
  assert.equal(footerWords({ app: 'opencode', context: { used: 1404175 } }), 'opencode · context 1.4M', 'no window known: the tokens only');
  // a small share of a big window: one decimal, never "0%" (Pi on GLM: 3k of 1M)
  assert.equal(footerWords({ app: 'pi', context: { used: 3000, size: 1e6 } }), 'pi · context 0.3% (3k)');
  assert.equal(footerWords({ app: 'pi', context: { used: 200, size: 1e6 } }), 'pi · context 0.1% (200)');
  assert.equal(footerWords({ app: 'x', limits: [{ name: '7-day', used: NaN }] }), 'x');
  assert.equal(tokens(999), '999');
  assert.equal(tokens(2000000), '2M');
  assert.deepEqual([300, 10080, 90].map(windowName), ['5-hour', '7-day', '90-minute']);
});

test('the branch comes from git in the terminal\'s folder: its name, its commit when on none, nothing outside a repository', async () => {
  const scripts = [];
  const shell = (out) => async (script) => { scripts.push(script); return out; };
  assert.equal(await branchOf(shell('main\n'), '/w/it\'s'), 'main');
  assert.ok(scripts[0].startsWith("cd '/w/it'\\''s'"), 'the folder is quoted');
  assert.equal(await branchOf(shell('a1b2c3d\n'), '/w'), 'a1b2c3d');
  assert.equal(await branchOf(shell(''), '/w'), '');
  assert.equal(await branchOf(shell('main'), ''), '', 'no folder known: no shell at all');
  assert.equal(scripts.length, 3);
});

test('a reading that costs a command is given as last known, and asked again only once it is old', async () => {
  forgetAll();
  let asks = 0;
  const ask = async () => { asks += 1; return asks; };
  assert.equal(lastKnown('k', 1000, ask, 0), undefined, 'the first post goes without it');
  await asked();
  assert.equal(lastKnown('k', 60000, ask), 1);
  assert.equal(lastKnown('k', 60000, ask), 1);
  await asked();
  assert.equal(asks, 1, 'not asked again while fresh');
  const failing = async () => { throw new Error('no claude here'); };
  assert.equal(lastKnown('f', 60000, failing), undefined);
  await asked();
  assert.equal(lastKnown('f', 60000, failing), undefined, 'a failure is not retried at once');
  forgetAll();
});

test('the first reading is waited for, briefly; after that the last one known is given at once', async () => {
  forgetAll();
  assert.equal(await knownSoon('w', 60000, async () => 1000000, 1000), 1000000, 'a restart\'s first post has it too');
  assert.equal(await knownSoon('slow', 60000, () => new Promise(() => {}), 20), undefined, 'one that hangs holds a post up only so long');
  forgetAll();
});
