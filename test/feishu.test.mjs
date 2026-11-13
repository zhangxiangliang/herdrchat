import assert from 'node:assert/strict';
import test from 'node:test';
import { chunk, messageParts, tagName } from '../lib/chats/feishu/client.mjs';

test('chunk keeps short text whole', () => {
  assert.deepEqual(chunk('hello\nworld'), ['hello\nworld']);
});

test('chunk splits on lines and never exceeds the size by much', () => {
  const text = Array.from({ length: 100 }, (_, i) => `line ${i} ${'x'.repeat(50)}`).join('\n');
  const parts = chunk(text, 1000);
  assert.ok(parts.length > 5);
  for (const p of parts) assert.ok(p.length <= 1010, `part of ${p.length}`);
  assert.equal(parts.join('\n').replace(/\n+/g, '\n'), text);
});

test('chunk closes and reopens a cut code fence', () => {
  const text = ['intro', '```js', ...Array.from({ length: 60 }, (_, i) => `const a${i} = ${i};`), '```', 'end'].join('\n');
  const parts = chunk(text, 300);
  for (const p of parts) {
    const fences = (p.match(/^```/gm) || []).length;
    assert.equal(fences % 2, 0, `unbalanced fences in:\n${p}`);
  }
  assert.ok(parts[1].startsWith('```js'));
});

test('chunk cuts a single very long line', () => {
  const parts = chunk('y'.repeat(2500), 1000);
  assert.equal(parts.length, 3);
  assert.equal(parts.join(''), 'y'.repeat(2500));
});

test('messageParts: text, image and rich text with images, nothing dropped', () => {
  assert.deepEqual(messageParts('text', '{"text":"hi"}'), { text: 'hi', images: [] });
  assert.deepEqual(messageParts('image', '{"image_key":"img_1"}'), { text: '', images: ['img_1'] });
  const post = { title: 'Bug', content: [[{ tag: 'text', text: 'see ' }, { tag: 'a', text: 'log', href: 'https://x.test' }], [{ tag: 'img', image_key: 'img_2' }], [{ tag: 'code_block', text: 'npm test' }]] };
  assert.deepEqual(messageParts('post', JSON.stringify(post)), { text: 'Bug\nsee log (https://x.test)\n\nnpm test', images: ['img_2'] });
  assert.equal(messageParts('file', '{}'), null);
});

test('tagName keeps short names and cuts long ones at a word', () => {
  assert.equal(tagName('alpha'), 'alpha');
  assert.equal(tagName('build-agent-server'), 'build-agent');
  assert.equal(tagName('averyveryverylongname'), 'averyveryverylon');
});

test('a multi-select card puts its boxes in a form as checkers that make no call, and Next submits it', async () => {
  const { menuCard, ticksOf } = await import('../lib/chats/feishu/client.mjs');
  const menu = { multi: true, free: null, options: [{ n: 1, label: 'Red', checked: true }, { n: 2, label: 'Green', checked: false }, { n: 3, label: 'Submit', checked: null }] };
  const card = menuCard({ title: 'T', markdown: 'Which?', menu, value: { s: 's', a: 't1', k: 'k' } });
  const form = card.body.elements.find((e) => e.tag === 'form' && e.name === 'boxes');
  const checkers = form.elements.filter((e) => e.tag === 'checker');
  assert.deepEqual(checkers.map((c) => [c.name, c.checked]), [['box_1', true], ['box_2', false]]);
  assert.ok(checkers.every((c) => !c.behaviors), 'a checker with no behaviors is ticked on the phone only');
  const next = form.elements.find((e) => e.tag === 'button');
  assert.equal(next.form_action_type, 'submit');
  assert.equal(next.behaviors[0].value.pick, 'tab');
  assert.ok(card.body.elements.some((e) => e.tag === 'button' && /Submit/.test(e.text.content)), 'an option with no box stays a button');
  const names = JSON.stringify(card).match(/"name":"[^"]+"/g);
  assert.equal(new Set(names).size, names.length, 'every name in the card is unique');
  assert.deepEqual(ticksOf({ box_1: true, box_2: 'false', box_3: 'true' }), { 1: true, 2: false, 3: true });
  assert.equal(ticksOf({ answer: 'x' }), null);
  assert.equal(ticksOf(undefined), null);
});

test('messageParts passes on text and images, and gives null for what it cannot read', () => {
  assert.deepEqual(messageParts('text', JSON.stringify({ text: 'hi' })), { text: 'hi', images: [] });
  assert.equal(messageParts('merge_forward', 'Merged and Forwarded Message'), null, 'not JSON: not passed on, never a throw');
  assert.equal(messageParts('text', 'null'), null);
  assert.equal(messageParts('file', JSON.stringify({ file_key: 'f' })), null);
});
