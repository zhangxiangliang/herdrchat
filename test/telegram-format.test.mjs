import assert from 'node:assert/strict';
import test from 'node:test';
import { bytesOf, dialogHtml, foldedHtml, lookOf, messagesOf, quoteOf, split, splitBody, toHtml } from '../lib/chats/telegram/render.mjs';

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

test('a post\'s blocks: a screen is shown as it is, whatever it holds, and a long one is cut on its lines', () => {
  const { messages } = messagesOf([{ kind: 'text', markdown: 'It **stopped**.' }, { kind: 'screen', text: '$ ls <a> & `b`\n```\n**ok**' }]);
  assert.deepEqual(messages, [{ html: 'It <b>stopped</b>.\n\n<pre>$ ls &lt;a&gt; &amp; `b`\n```\n**ok**</pre>', plain: 'It **stopped**.\n\n$ ls <a> & `b`\n```\n**ok**' }]);
  const long = Array.from({ length: 400 }, (_, i) => `line ${i} <${'x'.repeat(20)}>`).join('\n');
  const cut = messagesOf([{ kind: 'screen', text: long }]).messages;
  assert.ok(cut.length > 1);
  assert.ok(cut.every((m) => m.html.length <= 3800 && m.html.startsWith('<pre>') && m.html.endsWith('</pre>')));
  assert.equal(cut.map((m) => m.plain).join('\n'), long, 'nothing lost, nothing added');
  assert.deepEqual(messagesOf('plain **markdown**').messages, [{ html: 'plain <b>markdown</b>', plain: 'plain **markdown**' }], 'a string is one text block');
});

test('a dialog\'s words are shown as they are: its marks are not read, and a card kept from before (markdown) still shows', () => {
  const dialog = { title: '⚠️ Needs you', body: [{ kind: 'plain', text: 'Run `rm *.tmp` <here> & now?\n**sure**' }], menu: null };
  assert.equal(dialogHtml(dialog), '<b>⚠️ Needs you</b>\n\nRun `rm *.tmp` &lt;here&gt; &amp; now?\n**sure**');
  assert.equal(dialogHtml({ title: 'T', markdown: 'Run \\*.tmp' }), '<b>T</b>\n\nRun *.tmp');
});

test('your words: who in bold, then a quote of them as they are; another terminal\'s with whom to answer', () => {
  assert.deepEqual(messagesOf([{ kind: 'you', text: 'fix *it* <now>\n\nthanks' }]).messages, [{ html: '<b>You:</b>\n<blockquote>fix *it* &lt;now&gt;\n\nthanks</blockquote>', plain: 'You:\nfix *it* <now>\n\nthanks' }]);
  assert.equal(messagesOf([{ kind: 'you', text: 'look', from: 't7 <review>', answerTo: 't1' }]).messages[0].html, '<b>From t7 &lt;review&gt;</b> <i>(answer: t1)</i>\n<blockquote>look</blockquote>');
  // a long one: each message a whole quote, who said it only on the first
  const long = messagesOf([{ kind: 'you', text: Array.from({ length: 300 }, (_, i) => `line ${i} of what you said`).join('\n') }]).messages;
  assert.ok(long.length > 1 && long.every((m) => m.html.length <= 3800 && m.html.endsWith('</blockquote>')));
  assert.ok(long[0].html.startsWith('<b>You:</b>\n<blockquote>') && long[1].html.startsWith('<blockquote>'));
});

test('a live card\'s body: measured as it is sent, cut into bodies that each fit a message, sent as they were cut', () => {
  const body = [{ kind: 'you', text: 'go' }, { kind: 'text', markdown: 'done **now**' }];
  assert.equal(bytesOf(body), '<b>You:</b>\n<blockquote>go</blockquote>\n\ndone <b>now</b>'.length);
  const big = [{ kind: 'screen', text: Array.from({ length: 800 }, (_, i) => `row ${i}`).join('\n') }, { kind: 'text', markdown: 'after' }];
  const bodies = splitBody(big);
  assert.ok(bodies.length > 1 && bodies.every((b) => bytesOf(b) <= 3800));
  const look = lookOf({ title: 'T', body: bodies.at(-1), footer: {} });
  assert.ok(look.html.startsWith('<b>T</b>\n\n') && look.html.endsWith('after'));
  assert.equal(lookOf({ title: 'Bot', markdown: 'a **notice**' }).html, '<b>Bot</b>\n\na <b>notice</b>', 'a notice of the bot\'s own is markdown');
});

test('*italic* as well as _italic_; a lone star, stars with spaces round them and an escaped one are just stars', () => {
  assert.equal(toHtml('it is *done* now'), 'it is <i>done</i> now');
  assert.equal(toHtml('---\n*model: claude-opus-5-5*'), '---\n<i>model: claude-opus-5-5</i>');
  assert.equal(toHtml('run ls *.md here'), 'run ls *.md here');
  assert.equal(toHtml('2 * 3 * 4'), '2 * 3 * 4');
  assert.equal(toHtml('a \\*literal\\* star'), 'a *literal* star');
  assert.equal(toHtml('**bold** and *it*'), '<b>bold</b> and <i>it</i>');
});

test('a path is sent as code, so Telegram makes no command of it; the bot\'s own commands stay tappable', () => {
  assert.equal(toHtml('wrote /tmp/a.txt and ~/notes/x.md'), 'wrote <code>/tmp/a.txt</code> and <code>~/notes/x.md</code>');
  assert.equal(toHtml('in /tmp, then (/var/log)'), 'in <code>/tmp</code>, then (<code>/var/log</code>)');
  assert.equal(toHtml('here, /ls shows them all, /new starts one'), 'here, /ls shows them all, /new starts one');
  assert.equal(toHtml('and/or, see [docs](https://x.dev/a/b)'), 'and/or, see <a href="https://x.dev/a/b">docs</a>');
  assert.equal(dialogHtml({ title: 'T', body: [{ kind: 'plain', text: '$ touch /tmp/x' }] }), '<b>T</b>\n\n$ touch <code>/tmp/x</code>');
  assert.equal(messagesOf([{ kind: 'screen', text: '$ ls /tmp' }]).messages[0].html, '<pre>$ ls /tmp</pre>', 'a screen is no link already');
});

test('a folded post shows inline marks: who said it in bold, a quote\'s and a code block\'s lines as they are', () => {
  assert.equal(foldedHtml('Before', '**You:** 2026-01-01 10:00\n> fix *it* <now>\n\n```\nnpm test\n```\nDone.'), '<b>Before</b>\n<blockquote expandable><b>You:</b> 2026-01-01 10:00\nfix <i>it</i> &lt;now&gt;\n\n<code>npm test</code>\nDone.</blockquote>');
});

test('a ring quotes the start of the first line with words: no bold title, no footer, as Telegram shows it', () => {
  const q = (html) => quoteOf(html);
  assert.deepEqual(q('Fixed it: <code>T1_ABC</code> &lt;now&gt; &amp; <b>done</b>.\n\n<pre>ok</pre>\n\n<i>claude · m</i>'), { text: 'Fixed it: T1_ABC <now> &', entities: [] });
  assert.deepEqual(q('<b>⚠️ Needs you (permission)</b>\n\n╭──────╮\nAllow ls?\n\n<i>claude · screen</i>'), { text: 'Allow ls?', entities: [] });
  assert.deepEqual(q('<b>You:</b>\n<blockquote>typed in the terminal</blockquote>'), { text: 'typed in the terminal', entities: [] });
  assert.equal(Array.from(q('x'.repeat(200)).text).length, 80);
  assert.equal(q('<i>  </i>'), null);
});

test('a message with no unmarked words (an italic note alone) is quoted with its marks, where they are', () => {
  assert.deepEqual(quoteOf('<i>(It stopped: The user declined this tool call)</i>'), { text: '(It stopped: The user declined this tool call)', entities: [{ type: 'italic', offset: 0, length: 46 }] });
  assert.deepEqual(quoteOf('<b>Done</b> with <i>it</i> &amp; more'), { text: 'Done with it & more', entities: [{ type: 'bold', offset: 0, length: 4 }, { type: 'italic', offset: 10, length: 2 }] });
  const long = quoteOf(`<i>${'y'.repeat(100)}</i>`);
  assert.deepEqual([long.text.length, long.entities], [80, [{ type: 'italic', offset: 0, length: 80 }]]);
});

test('a Telegram call that got no answer is marked unreached; one Telegram refused is not', async () => {
  const { createClient } = await import('../lib/chats/telegram/client.mjs');
  const real = globalThis.fetch;
  try {
    globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
    await assert.rejects(createClient('t').call('editMessageText', {}), (err) => err.unreached === true);
    globalThis.fetch = async () => ({ json: async () => ({ ok: false, error_code: 400, description: 'Bad Request: message to edit not found' }) });
    await assert.rejects(createClient('t').call('editMessageText', {}), (err) => err.code === 400 && !err.unreached);
    globalThis.fetch = async () => ({ json: async () => ({ ok: false, error_code: 502, description: 'Bad Gateway' }) });
    await assert.rejects(createClient('t').call('editMessageText', {}), (err) => err.unreached === true);
  } finally {
    globalThis.fetch = real;
  }
});
