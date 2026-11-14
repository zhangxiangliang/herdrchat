import assert from 'node:assert/strict';
import test from 'node:test';
import { split, toHtml } from '../lib/chats/telegram/render.mjs';

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

test('Telegram: an image it will not take as a photo goes as a file, not lost', async () => {
  const os = await import('node:os');
  const telegram = await import('../lib/chats/telegram/index.mjs');
  const { fakeStore } = await import('./fakes.mjs');
  const store = fakeStore();
  const state = store.read();
  state.chats = { 'a|t1': { chat: '11', name: 'work / master' } };
  store.write(state);
  const cfg = { env: { TELEGRAM_BOT_TOKEN: '1:test', TELEGRAM_OWNER_ID: '42' }, sessions: ['a'], muted: { all: true, spaces: [] }, silent: { all: false, spaces: [] } };
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const method = url.split('/').pop();
    sent.push(method);
    if (method === 'sendPhoto') return { ok: false, status: 400, json: async () => ({ ok: false, error_code: 400, description: 'Bad Request: PHOTO_INVALID_DIMENSIONS' }) };
    return { ok: true, json: async () => ({ ok: true, result: { message_id: sent.length } }) };
  };
  try {
    const quiet = () => {};
    const chat = telegram.create({ cfg, store, log: quiet, logWarn: quiet, logError: quiet, stateDir: os.tmpdir(), lane: () => {}, scopeOf: () => 'a' });
    const mark = await chat.image(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0]));
    await chat.post('11', `a long screenshot\n\n${mark}`);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(sent.filter((m) => m !== 'sendMessage'), ['sendPhoto', 'sendDocument']);
});
