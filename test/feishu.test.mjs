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
