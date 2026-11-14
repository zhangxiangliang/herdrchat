import assert from 'node:assert/strict';
import test from 'node:test';
import { conversationAfter, leftInput, pickLog, titleOf } from '../lib/core/readers/codex.mjs';
import { seconds } from '../lib/core/shell.mjs';
import { LISTED, agentOf } from '../lib/core/readers/index.mjs';
import { startCursor } from '../lib/core/cursor.mjs';
import { menuOf } from '../lib/core/menu.mjs';

// A Codex rollout log, shaped as Codex 0.169 writes it (made up, not a real session).
const at = (s) => `2026-01-02T00:00:${String(s).padStart(2, '0')}.000Z`;
const done = (s, item) => JSON.stringify({ timestamp: at(s), type: 'event_msg', payload: { type: 'item_completed', thread_id: 'th', turn_id: 'tu', item } });
const LOG = [
  JSON.stringify({ timestamp: at(0), type: 'session_meta', payload: { id: 'th', cwd: '/w', originator: 'codex-tui' } }),
  JSON.stringify({ timestamp: at(1), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>…' }] } }),
  done(2, { type: 'UserMessage', id: 'u1', content: [{ type: 'text', text: 'run the tests' }] }),
  done(3, { type: 'AgentMessage', id: 'a1', content: [{ type: 'Text', text: 'Running them now.' }], phase: 'commentary' }),
  done(3, { type: 'CommandExecution', id: 'c1', command: ['/bin/zsh', '-lc', 'npm test'], cwd: '/w' }),
  done(4, { type: 'FileChange', id: 'f1', changes: { '/w/a.txt': { type: 'add', content: 'x' }, '/w/b.txt': { type: 'update' } } }),
  done(4, { type: 'Reasoning', id: 'r1' }),
  done(5, { type: 'AgentMessage', id: 'a2', content: [{ type: 'Text', text: 'Which one?\n- A\n- B' }], phase: 'final_answer', delivery: 'async' }),
  done(6, { type: 'AgentMessage', id: 'a3', content: [{ type: 'Text', text: 'All pass.' }], phase: 'final_answer' }),
  JSON.stringify({ timestamp: at(7), type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'All pass.' } }),
];

test('the Codex reader keeps what you typed, what it said, and its commands and edits as one line each', () => {
  const { items } = conversationAfter(LOG, startCursor(at(0)));
  assert.deepEqual(items.map((it) => [it.role, it.text, Boolean(it.end)]), [
    ['you', 'run the tests', false],
    ['ai', 'Running them now.', false],
    ['tool', '▸ exec: npm test', false],
    ['tool', '▸ edit: add a.txt, update b.txt', false],
    ['ai', 'Which one?\n- A\n- B', false],
    ['ai', 'All pass.', true],
  ]);
  assert.equal(new Set(items.map((it) => it.id)).size, items.length, 'two items in the same millisecond keep apart');
});

test('a Codex terminal is read by the Codex reader, and only while codex runs in it', () => {
  assert.ok(LISTED.some((r) => r.app === 'codex'));
  assert.equal(agentOf({ status: { app: 'codex' }, foreground: { name: 'codex', argv: ['codex'] } })?.app, 'codex');
  assert.equal(agentOf({ status: { app: 'codex' }, foreground: { name: 'zsh', argv: ['/bin/zsh'] } }), null);
});

test('the log of a codex is the one in its folder that began as it started', () => {
  assert.equal(seconds('05:07'), 307);
  assert.equal(seconds('1-02:03:04'), 93784);
  const started = Date.parse('2026-01-02T10:00:00.000Z');
  const list = [
    'a.jsonl\t"cwd":"/w"\t"timestamp":"2026-01-02T09:00:00.000Z"', // resumed earlier session, also written to
    'b.jsonl\t"cwd":"/other"\t"timestamp":"2026-01-02T10:00:01.000Z"', // another folder
    'c.jsonl\t"cwd":"/w"\t"timestamp":"2026-01-02T10:00:02.000Z"', // this one
    'd.jsonl\t"cwd":"/w"\t"timestamp":"2026-01-02T10:30:00.000Z"', // a later codex in the same folder
  ].join('\n');
  assert.equal(pickLog(list, '/w', started), 'c.jsonl');
  assert.equal(pickLog('a.jsonl\t"cwd":"/w"\t"timestamp":"2026-01-02T09:00:00.000Z"', '/w', started), 'a.jsonl', 'resumed: the one there is');
  assert.equal(pickLog(list, '/none', started), null);
});

test('a Codex room is named after its thread, and the name does not follow its state', () => {
  assert.equal(titleOf('codex | herdrchat'), 'codex');
  assert.equal(titleOf('⠦ codex | herdrchat'), 'codex');
  assert.equal(titleOf('[ . ] Action Required | codex | herdrchat'), 'codex');
  assert.equal(titleOf('Fix the login page | herdrchat'), 'Fix the login page');
});

test('a Codex approval is a menu: › for the cursor, no border, the dialog under its "• Running" line', () => {
  const screen = [
    '• Ran curl -sI https://example.com',
    '  └ (no output)',
    '',
    '• Running curl -sI https://example.com',
    '',
    '  Would you like to run the following command?',
    '',
    '  $ curl -sI https://example.com',
    '',
    '› 1. Yes, proceed (y)',
    "  2. Yes, and don't ask again for commands that start with `curl` (p)",
    '  3. No, and tell Codex what to do differently (esc)',
    '',
    '  Press enter to confirm or esc to cancel',
  ].join('\n');
  const m = menuOf(screen);
  assert.equal(m.framed, true);
  assert.equal(m.cursor, 1);
  assert.deepEqual(m.options.map((o) => o.label), ['Yes, proceed (y)', "Yes, and don't ask again for commands that start with `curl` (p)", 'No, and tell Codex what to do differently (esc)']);
  assert.equal(m.text, '• Running curl -sI https://example.com\nWould you like to run the following command?\n$ curl -sI https://example.com');
  assert.equal(menuOf(screen.replace('› 1.', '  1.').replace('  2.', '› 2.')).key, m.key, 'the cursor moving keeps the key');
});

test('a Codex turn names its model once, at its start: an item of its own', () => {
  const lines = [JSON.stringify({ timestamp: at(1), type: 'turn_context', payload: { cwd: '/w', model: 'gpt-model-x' } }), done(2, { type: 'AgentMessage', id: 'a', content: [{ type: 'Text', text: 'Hi.' }], phase: 'final_answer' })];
  assert.deepEqual(conversationAfter(lines, startCursor(at(0))).items.map((it) => [it.role, it.model || it.text]), [['meta', 'gpt-model-x'], ['ai', 'Hi.']]);
});

test('a Codex token_count tells how full the context is and the limits, shortest window first', () => {
  const tc = (payload) => JSON.stringify({ timestamp: at(1), type: 'event_msg', payload: { type: 'token_count', ...payload } });
  const lines = [tc({ info: { last_token_usage: { total_tokens: 25871 }, model_context_window: 475000 }, rate_limits: { primary: { used_percent: 65, window_minutes: 10080 }, secondary: { used_percent: 3, window_minutes: 300 } } })];
  assert.deepEqual(conversationAfter(lines, startCursor(at(0))).items.map(({ role, context, limits }) => ({ role, context, limits })),
    [{ role: 'meta', context: { used: 25871, size: 475000 }, limits: [{ name: '5-hour', used: 3 }, { name: '7-day', used: 65 }] }]);
  assert.deepEqual(conversationAfter([tc({ info: null, rate_limits: null })], startCursor(at(0))).items, [], 'one that tells nothing is nothing');
});

test('what Codex did not take is emptied from its input box only when your words are there', () => {
  const left = "• Unrecognized command '/nosuchcmd'.\n› /nosuchcmd now\n\n  GPT-6.1-Sol default · ~/w";
  assert.deepEqual(leftInput(left, '/nosuchcmd now'), ['ctrl+c']);
  // an empty box (its placeholder), or your words only in its history: nothing pressed
  assert.equal(leftInput('› /nosuchcmd now\n• done\n› Ask Codex to do anything\n  GPT-6.1-Sol', '/nosuchcmd now'), null);
  assert.equal(leftInput(left, ''), null);
});
