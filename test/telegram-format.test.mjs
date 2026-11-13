import assert from 'node:assert/strict';
import test from 'node:test';
import { split, toHtml } from '../lib/chats/telegram/format.mjs';

test('markdown becomes Telegram HTML, with everything else escaped', () => {
  assert.equal(toHtml('**You:**\n> a < b & c\n> two'), '<b>You:</b>\n<blockquote>a &lt; b &amp; c\ntwo</blockquote>');
  assert.equal(toHtml('run `npm test` in [the repo](https://x.dev/a?b=1&c=2)'), 'run <code>npm test</code> in <a href="https://x.dev/a?b=1&amp;c=2">the repo</a>');
  assert.equal(toHtml('```\n<div> & **not bold**\n```'), '<pre>&lt;div&gt; &amp; **not bold**</pre>');
  assert.equal(toHtml('an _italic_ word, snake_case_name stays'), 'an <i>italic</i> word, snake_case_name stays');
  assert.equal(toHtml('1. Yes \\*really\\*'), '1. Yes *really*');
});

test('a code block that is not closed is closed', () => {
  assert.equal(toHtml('```\nline'), '<pre>line</pre>');
});

test('long text is cut into pieces that each convert on their own', () => {
  const block = ['```', ...Array.from({ length: 30 }, (_, i) => `line ${i} ${'x'.repeat(20)}`), '```'].join('\n');
  const pieces = split(block, 200);
  assert.ok(pieces.length > 1);
  for (const p of pieces) {
    assert.ok(p.length <= 210, `piece of ${p.length}`);
    assert.match(toHtml(p), /^<pre>[\s\S]*<\/pre>$/);
  }
  assert.deepEqual(split('short'), ['short']);
});
