import assert from 'node:assert/strict';
import test from 'node:test';
import { conversationAfter, laterDialog, laterMessage, planDialog, questionOnScreen, questionsIn } from '../lib/core/readers/codex.mjs';

// log lines as Codex 0.169 writes them (only what is read here)
const call = (id, questions) => JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'request_user_input', arguments: JSON.stringify({ questions }), call_id: id } });
const output = (id) => JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', call_id: id, output: '{"answers":{}}' } });
const event = (payload) => JSON.stringify({ type: 'event_msg', payload });
const item = (it) => event({ type: 'item_completed', item: it });
const PLAN = [
  { header: 'Fruit', id: 'fruit', question: 'Which fruit?', options: [{ label: 'Apple', description: 'Choose Apple.' }, { label: 'Pear', description: 'Choose Pear.' }] },
  { header: 'Size', id: 'size', question: 'Which size?', options: [{ label: 'Small', description: 'Choose Small.' }, { label: 'Large', description: 'Choose Large.' }] },
];
const ASYNC = { type: 'AgentMessage', id: 'call_a', content: [{ type: 'Text', text: 'Which fruit?\n- Apple\n- Pear' }], phase: 'final_answer', delivery: 'async', questions: [{ title: 'Which fruit?', options: ['Apple', 'Pear'] }, { title: 'Which size?', options: ['Small', 'Large'] }] };

test('a Plan mode question waits until its output is written, or its turn ends', () => {
  assert.equal(questionsIn(['{"cut', call('c1', PLAN)]).plan.id, 'c1', 'a cut first line is skipped');
  assert.equal(questionsIn([call('c1', PLAN), output('c1')]).plan, null);
  assert.equal(questionsIn([call('c1', PLAN), event({ type: 'turn_aborted' })]).plan, null);
  assert.equal(questionsIn([call('c1', PLAN), output('c0')]).plan.id, 'c1', 'another call\'s output');
});

test('an async question waits until your next message', () => {
  assert.equal(questionsIn([item(ASYNC)]).later.id, 'call_a');
  assert.equal(questionsIn([item(ASYNC), event({ type: 'task_complete' })]).later.id, 'call_a', 'its turn ending does not answer it');
  assert.equal(questionsIn([item(ASYNC), item({ type: 'UserMessage', content: [{ type: 'text', text: 'Pear' }] })]).later, null);
});

test('the screen tells which Plan mode question is shown, and where its cursor is', () => {
  const screen = '› Test\n\n  Question 2/2 (1 unanswered)\n  Which size?\n\n    1. Small              Choose Small.\n  › 2. Large              Choose Large.\n    3. None of the above  Optionally, add details in notes (tab)\n\n  tab to add notes | enter to submit all';
  const on = questionOnScreen(screen);
  assert.deepEqual({ index: on.index, count: on.count, cursor: on.cursor }, { index: 1, count: 2, cursor: 2 });
  assert.ok(on.words.includes('Which size?'));
  assert.equal(questionOnScreen('› Ask Codex to do anything'), null);
});

test('a Plan mode question\'s card has its own words, its options, and your own answer last', () => {
  const d = planDialog({ id: 'c1', questions: PLAN }, 1);
  assert.equal(d.key, 'c1#1');
  assert.deepEqual(d.options.map((o) => o.label), ['Small', 'Large', 'None of the above (your own words)']);
  assert.equal(d.free.n, 3);
  assert.equal(d.text, 'Size\nWhich size?\nSmall: Choose Small.\nLarge: Choose Large.\n(question 2 of 2)');
  assert.equal(planDialog({ id: 'c1', questions: PLAN }, 2), null);
});

test('async questions go one card each, and the answer is one message', () => {
  const later = { id: 'call_a', questions: ASYNC.questions };
  const first = laterDialog(later);
  assert.equal(first.key, 'call_a#0');
  assert.equal(first.idle, true);
  assert.deepEqual(first.options.map((o) => o.label), ['Apple', 'Pear', 'Type your own answer']);
  assert.equal(laterDialog(later, { 0: 'Pear' }).key, 'call_a#1');
  assert.equal(laterDialog(later, { 0: 'Pear', 1: 'Large' }), null);
  assert.equal(laterMessage(['Which fruit?'], ['Pear']), 'Pear');
  assert.equal(laterMessage(['Which fruit?', 'Which size?'], ['Pear', 'Large']), 'Which fruit? Pear\nWhich size? Large');
});

test('in the conversation an async question is one line; its card has the options', () => {
  const { items } = conversationAfter([JSON.stringify({ timestamp: '2026-11-14T00:00:00.000Z', ...JSON.parse(item(ASYNC)) })], { at: '', seen: [] });
  assert.deepEqual(items.map((it) => [it.role, it.text]), [['tool', '▸ asks you: Which fruit? · Which size?']]);
});
