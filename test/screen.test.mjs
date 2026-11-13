import assert from 'node:assert/strict';
import test from 'node:test';
import { plainError, tidyScreen } from '../lib/core/hc.mjs';
import { agentOf } from '../lib/core/readers/index.mjs';

test('a screen loses blank ends and runs of blank lines', () => {
  const raw = '\n\n  switch to which account?   \n\n\n  2  someone\n\n\n\n\n\n  ⏎ Switch  esc Back\n\n\n';
  assert.equal(tidyScreen(raw), '  switch to which account?\n\n  2  someone\n\n  ⏎ Switch  esc Back');
  assert.equal(tidyScreen(raw, 1), '  ⏎ Switch  esc Back');
  assert.equal(tidyScreen('\n \n'), '');
});

test('a failed hc call reads as hc says it, not as its command line', () => {
  const finished = new Error('hc put t1 /tmp/x.png --json: {"error":{"hint":"nothing there to read it","kind":"finished","message":"t1 has finished"}}');
  assert.equal(plainError(finished), 'this terminal has ended.');
  const other = new Error('hc send t3 hi: {"error":{"kind":"not_found","message":"no terminal \\"t3\\""}}');
  assert.equal(plainError(other), 'no terminal "t3"');
  assert.equal(plainError(new Error('hc keys t3 esc: connection refused')), 'connection refused');
});

test('only a running agent is mirrored, whatever its status still says', () => {
  const claude = { status: { app: 'claude-code', state: 'blocked' }, foreground: { name: 'claude', argv: ['claude'] } };
  assert.equal(agentOf(claude)?.app, 'claude-code');
  // installed through npm: the process is node, started as claude
  assert.equal(agentOf({ ...claude, foreground: { name: 'node', argv: ['/usr/local/bin/claude'] } })?.app, 'claude-code');
  // Claude quit; its status stayed, a tool runs now
  assert.equal(agentOf({ ...claude, foreground: { name: 'cswap', argv: ['cswap'] } }), null);
  assert.equal(agentOf({ ...claude, foreground: { name: 'zsh', argv: ['-zsh'] } }), null);
  // nothing known about the foreground: the status decides, never silence for missing data
  assert.equal(agentOf({ status: { app: 'claude-code' } })?.app, 'claude-code');
  assert.equal(agentOf({ status: null, foreground: { name: 'zsh' } }), null);
});

test('an unreachable machine is told apart from other hc errors', async () => {
  const { isUnavailable } = await import('../lib/core/hc.mjs');
  assert.equal(isUnavailable(new Error('hc get srv/t5 --json: {"error":{"kind":"unavailable","message":"srv is unreachable"}}')), true);
  assert.equal(isUnavailable(new Error('hc get t5 --json: {"error":{"kind":"not_found","message":"no terminal"}}')), false);
});
