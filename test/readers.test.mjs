import assert from 'node:assert/strict';
import test from 'node:test';
import { conversationAfter } from '../lib/core/readers/claude.mjs';
import { startCursor } from '../lib/core/cursor.mjs';
import { readerFor } from '../lib/core/readers/index.mjs';

test('a reader is picked by the app name hc reports; anything else has none', () => {
  assert.equal(readerFor('claude-code').app, 'claude-code');
  assert.equal(readerFor('some-other-agent'), null);
  assert.equal(readerFor(undefined), null);
});

// Claude Code's transcript
const at = (s) => new Date(Date.UTC(2026, 10, 12, 0, 0, s)).toISOString();
const entry = (o) => JSON.stringify(o);
const human = (s, text, uuid) => entry({ type: 'user', uuid, timestamp: at(s), origin: { kind: 'human' }, message: { content: text } });
const ai = (s, text, uuid, end = false) => entry({ type: 'assistant', uuid, timestamp: at(s), message: { stop_reason: end ? 'end_turn' : 'tool_use', content: [{ type: 'text', text }] } });

test('conversationAfter keeps your prompts, mid-turn messages and answers, in order', () => {
  const lines = [
    '{"cut',
    human(1, 'before the start', 'u1'),
    human(3, 'deploy it', 'u2'),
    entry({ type: 'user', uuid: 'm', timestamp: at(4), isMeta: true, message: { content: '[Image: source]' } }),
    entry({ type: 'assistant', uuid: 'a1', timestamp: at(5), message: { content: [{ type: 'text', text: 'Checking.' }, { type: 'tool_use', id: 'x' }] } }),
    entry({ type: 'user', uuid: 'r', timestamp: at(6), message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] } }),
    entry({ type: 'queue-operation', operation: 'enqueue', timestamp: at(7), content: 'also staging' }),
    entry({ type: 'queue-operation', operation: 'remove', reason: 'absorbed_mid_turn', timestamp: at(7), content: 'also staging' }),
    entry({ type: 'attachment', uuid: 'q1', timestamp: at(7), attachment: { type: 'queued_command', prompt: 'also staging', origin: { kind: 'human' } } }),
    entry({ type: 'attachment', uuid: 'q2', timestamp: at(7), attachment: { type: 'queued_command', prompt: '<task-notification>done</task-notification>', origin: { kind: 'task-notification' } } }),
    entry({ type: 'user', uuid: 'n', timestamp: at(7), origin: { kind: 'task-notification' }, message: { content: '<task-notification>done</task-notification>' } }),
    entry({ type: 'assistant', uuid: 's', timestamp: at(8), isSidechain: true, message: { content: [{ type: 'text', text: 'subagent noise' }] } }),
    entry({ type: 'user', uuid: 'i', timestamp: at(8), message: { content: '<system-reminder>injected</system-reminder>' } }),
    ai(9, 'Done.', 'a2', true),
  ];
  const { items, complete } = conversationAfter(lines, startCursor(at(2)));
  assert.deepEqual(items.map(({ role, text }) => `${role}: ${text}`), ['you: deploy it', 'ai: Checking.', 'tool: ▸ tool', 'you: also staging', 'ai: Done.']);
  assert.deepEqual(items.map((x) => Boolean(x.end)), [false, false, false, false, true]);
  assert.equal(new Set(items.map((x) => x.id)).size, items.length);
  assert.equal(complete, true);
});

test('narration blocks count as answers, plain thinking does not', () => {
  const sig = (word) => Buffer.from(`\u0008\u0004${word}\u0012xyz`).toString('base64');
  const lines = [
    entry({ type: 'assistant', uuid: 't1', timestamp: at(10), message: { stop_reason: 'tool_use', content: [{ type: 'thinking', thinking: 'private reasoning', signature: sig('thinking') }] } }),
    entry({ type: 'assistant', uuid: 'n1', timestamp: at(10), message: { stop_reason: 'tool_use', content: [{ type: 'thinking', thinking: 'Found the cause; fixing it.', signature: sig('narration') }] } }),
    entry({ type: 'assistant', uuid: 'e1', timestamp: at(11), message: { stop_reason: 'tool_use', content: [{ type: 'thinking', thinking: '', signature: sig('narration') }] } }),
  ];
  assert.deepEqual(conversationAfter(lines, startCursor(at(0))).items.map((x) => x.text), ['Found the cause; fixing it.']);
});

test('tool calls become one line each, with what they do', () => {
  const lines = [
    entry({ type: 'assistant', uuid: 'b1', timestamp: at(10), message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test', description: 'Run the unit tests' } }] } }),
    entry({ type: 'assistant', uuid: 'r1', timestamp: at(11), message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/tmp/a.js' } }] } }),
  ];
  assert.deepEqual(conversationAfter(lines, startCursor(at(0))).items.map((x) => x.text), ['▸ Bash: Run the unit tests', '▸ Read: /tmp/a.js']);
});

test('your answers to its questions are yours', () => {
  const line = entry({ type: 'user', uuid: 'q1', timestamp: at(10), message: { content: [{ type: 'tool_result', content: 'answered' }] }, toolUseResult: { answers: { 'Pick colors': 'Red, Blue', 'Pick a size': 'Medium' } } });
  assert.deepEqual(conversationAfter([line], startCursor(at(0))).items.map(({ role, text }) => `${role}: ${text}`), ['you: Pick colors → Red, Blue\nPick a size → Medium']);
});

test('images: ones you pasted and ones a tool showed it, never meta or subagent ones', () => {
  const img = (data) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } });
  const lines = [
    entry({ type: 'user', uuid: 'p', timestamp: at(10), origin: { kind: 'human' }, message: { content: [{ type: 'text', text: 'look' }, img('AAA')] } }),
    entry({ type: 'user', uuid: 's', timestamp: at(11), message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: [img('BBB')] }] } }),
    entry({ type: 'user', uuid: 'm', timestamp: at(12), isMeta: true, message: { content: [img('CCC')] } }),
    entry({ type: 'user', uuid: 'c', timestamp: at(13), isSidechain: true, message: { content: [{ type: 'tool_result', content: [img('DDD')] }] } }),
  ];
  const items = conversationAfter(lines, startCursor(at(0))).items;
  assert.deepEqual(items.map((x) => `${x.role}/${x.from || ''}/${x.data || x.text}`), ['you//look', 'image/you/AAA', 'image/ai/BBB']);
  assert.equal(new Set(items.map((x) => x.id)).size, 3);
});

test('each Claude answer names the model that wrote it; a reply Claude Code made up names none', () => {
  const lines = [
    entry({ type: 'assistant', uuid: 'a', timestamp: at(1), message: { model: 'claude-model-x', stop_reason: 'tool_use', content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 'x' }] } }),
    entry({ type: 'assistant', uuid: 'b', timestamp: at(2), message: { model: '<synthetic>', stop_reason: 'end_turn', content: [{ type: 'text', text: 'No response requested.' }] } }),
  ];
  assert.deepEqual(conversationAfter(lines, startCursor(at(0))).items.map((x) => x.model), ['claude-model-x', 'claude-model-x', undefined]);
});
