import assert from 'node:assert/strict';
import test from 'node:test';
import { conversationAfter, dialogOf, linesOf, pickSession, titleOf } from '../lib/core/readers/opencode.mjs';
import { LISTED, agentOf } from '../lib/core/readers/index.mjs';
import { startCursor } from '../lib/core/cursor.mjs';

// Shaped as OpenCode 2.3's API gives them (made up, not a real session).
const ms = (s) => Date.parse(`2026-01-02T00:00:${String(s).padStart(2, '0')}.000Z`);
const MESSAGES = [
  { id: 'm1', type: 'user', text: 'list the files', time: { created: ms(1) } },
  { id: 'm2', type: 'assistant', time: { created: ms(2) }, content: [{ type: 'reasoning', text: 'thinking' }, { type: 'tool', name: 'shell', state: { input: { command: 'ls -la' } } }] },
  { id: 'm3', type: 'assistant', time: { created: ms(3) }, content: [{ type: 'text', text: 'Two files.' }] },
  { id: 'm4', type: 'idle', time: { created: ms(4) }, outcome: 'succeeded' },
  { id: 'm5', type: 'user', text: 'pick a color', time: { created: ms(5) } },
  { id: 'm6', type: 'assistant', time: { created: ms(6) }, content: [{ type: 'tool', name: 'question', state: { input: { questions: [{ question: 'Which color?' }] } } }] },
];

test('the OpenCode reader keeps what you typed, what it said, its tools as one line, and where a turn ends', () => {
  const { items } = conversationAfter(linesOf(MESSAGES), startCursor('2026-01-01T00:00:00.000Z'));
  assert.deepEqual(items.map((it) => [it.role, it.text, Boolean(it.end)]), [
    ['you', 'list the files', false],
    ['tool', '▸ shell: ls -la', false],
    ['ai', 'Two files.', true],
    ['you', 'pick a color', false],
    ['tool', '▸ question: Which color?', false],
  ]);
});

test('an OpenCode terminal is read by its reader, and its session is its folder\'s active one', () => {
  assert.ok(LISTED.some((r) => r.app === 'opencode'));
  assert.equal(agentOf({ status: { app: 'opencode' }, foreground: { name: 'opencode', argv: ['opencode'] } })?.app, 'opencode');
  const list = [
    { id: 'a', directory: '/w', updated: 30 },
    { id: 'b', directory: '/w', updated: 10 },
    { id: 'c', directory: '/other', updated: 99 },
  ];
  assert.equal(pickSession(list, {}, '/w'), 'a', 'none active: the one updated last');
  assert.equal(pickSession(list, { b: { type: 'running' } }, '/w'), 'b', 'the active one first');
  assert.equal(pickSession(list, {}, '/none'), null);
  assert.equal(titleOf('OC | Greeting'), 'Greeting');
});

test('an OpenCode form is a dialog, one question at a time, with your own words when it takes them', () => {
  const forms = [{
    id: 'frm1',
    title: 'Questions',
    metadata: { kind: 'question' },
    fields: [
      { key: 'q0', title: 'Color choice', description: 'Which color?', type: 'string', options: [{ value: 'Red', label: 'Red' }, { value: 'Green', label: 'Green' }], custom: true },
      { key: 'q1', title: 'Sizes', description: 'Which sizes?', type: 'multiselect', options: [{ value: 'S', label: 'Small' }, { value: 'L', label: 'Large' }] },
    ],
  }];
  const first = dialogOf(forms, []);
  assert.equal(first.key, 'frm1#q0');
  assert.deepEqual(first.options.map((o) => `${o.n}. ${o.label}`), ['1. Red', '2. Green', '3. Type your own answer']);
  assert.equal(first.free.n, 3);
  assert.match(first.text, /Which color\?\n\(question 1 of 2\)/);
  const second = dialogOf(forms, [], new Map([['frm1', { q0: 'Red' }]]));
  assert.equal(second.key, 'frm1#q1');
  assert.equal(second.multi, true);
  assert.deepEqual(second.options.map((o) => o.checked), [false, false]);
  assert.equal(second.free, null);
});

test('an OpenCode permission request is a dialog: once, always, reject', () => {
  const d = dialogOf([], [{ id: 'per1', sessionID: 's', action: 'edit', resources: ['/w/a.txt'], message: 'Edit a.txt?' }]);
  assert.equal(d.key, 'permission#per1');
  assert.equal(d.kind, 'permission');
  assert.deepEqual(d.options.map((o) => [o.label, o.value]), [['Allow once', 'once'], ['Allow always', 'always'], ['Reject', 'reject']]);
  assert.match(d.text, /Edit a\.txt\?\nedit\n\/w\/a\.txt/);
  assert.equal(dialogOf([], []), null);
});

test('each OpenCode answer names the model that wrote it', () => {
  const said = [{ id: 'x', type: 'assistant', time: { created: ms(1) }, model: { id: 'model-x', providerID: 'p' }, content: [{ type: 'text', text: 'Hi.' }] }];
  assert.deepEqual(conversationAfter(linesOf(said), startCursor('2026-01-01T00:00:00.000Z')).items.map((it) => it.model), ['model-x']);
});

test('OpenCode: how full the context is comes with each answer, its window from its own model list', async () => {
  const { windowOf } = await import('../lib/core/readers/opencode.mjs');
  const said = [{ id: 'x', type: 'assistant', time: { created: ms(1) }, model: { id: 'glm', providerID: 'zhipu' }, tokens: { input: 3609, output: 20, cache: { read: 4096, write: 1 } }, content: [{ type: 'text', text: 'Hi.' }] }];
  assert.deepEqual(conversationAfter(linesOf(said), startCursor('2026-01-01T00:00:00.000Z')).items.map((it) => [it.provider, it.context]), [['zhipu', { used: 7706 }]]);
  const models = [{ modelID: 'glm', providerID: 'other', limit: { context: 200000 } }, { modelID: 'glm', providerID: 'zhipu', limit: { context: 1000000 } }];
  assert.equal(windowOf(models, 'glm', 'zhipu'), 1000000, 'the provider it runs through');
  assert.equal(windowOf(models, 'glm', 'gone'), 200000);
  assert.equal(windowOf(null, 'glm'), undefined);
});
