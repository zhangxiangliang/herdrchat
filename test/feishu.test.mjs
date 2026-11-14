import assert from 'node:assert/strict';
import test from 'node:test';
import { chunk, messageParts, summaryOf, tagName } from '../lib/chats/feishu/client.mjs';

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
  const buttons = card.body.elements.filter((e) => e.tag === 'column_set').flatMap((r) => r.columns.flatMap((c) => c.elements));
  assert.ok(buttons.some((e) => e.tag === 'button' && /Submit/.test(e.text.content)), 'an option with no box stays a button');
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

test('a dialog card: an icon in its header, its options side by side and wrapping, Esc as quiet text', async () => {
  const { menuCard, textCard } = await import('../lib/chats/feishu/client.mjs');
  const menu = { multi: false, free: null, options: [{ n: 1, label: 'Yes', checked: null }, { n: 2, label: 'No', checked: null }] };
  const card = menuCard({ title: '⚠️ Needs you (permission)', markdown: 'Run it?', menu, value: { s: 's', a: 't1', k: 'k' } });
  assert.equal(card.header.title.content, 'Needs you (permission)', 'the emoji gives way to the icon');
  assert.equal(card.header.icon.token, 'warning_outlined');
  const [options, esc] = card.body.elements.filter((e) => e.tag === 'column_set');
  assert.equal(options.flex_mode, 'flow');
  assert.deepEqual(options.columns.map((c) => [c.elements[0].text.content, c.elements[0].type, c.elements[0].width]), [['1. Yes', 'primary_filled', 'default'], ['2. No', 'default', 'default']]);
  assert.equal(esc.columns[0].elements[0].type, 'danger_text');
  assert.equal(textCard('x', '⌛️ Working…', 'working').header.icon.token, 'loading_outlined');
  assert.equal(textCard('x', '✅ Worked', 'closed').header.title.content, 'Worked');
});

test('an answered dialog shows one check: the icon, not the core\'s ✔ as well', async () => {
  const { doneCard } = await import('../lib/chats/feishu/client.mjs');
  const card = doneCard('✅ Done', 'Run it?', '✔ 1. Yes');
  const note = card.body.elements[1];
  assert.equal(note.content, '1. Yes');
  assert.equal(note.icon.token, 'done_outlined');
});

test('long options are a line each, at the left and as wide as their words; short ones sit side by side', async () => {
  const { menuCard } = await import('../lib/chats/feishu/client.mjs');
  const long = { multi: false, free: null, options: [{ n: 1, label: 'Yes, proceed (y)', checked: null }, { n: 2, label: "Yes, and don't ask again for commands that start with `curl` (p)", checked: null }, { n: 3, label: 'No, and tell Codex what to do differently (esc)', checked: null }] };
  const card = menuCard({ title: 'Needs you', markdown: 'Run it?', menu: long, value: {} });
  const buttons = card.body.elements.filter((e) => e.tag === 'button');
  assert.deepEqual(buttons.map((b) => [b.text.content.slice(0, 6), b.width]), [['1. Yes', 'default'], ['2. Yes', 'default'], ['3. No,', 'default']]);
  assert.equal(buttons[1].hover_tips.content, "2. Yes, and don't ask again for commands that start with `curl` (p)");
});

test('a post is quoted by its first line with words, not by its footer', () => {
  // a screen: the code block's first line, not the footer under it
  assert.equal(summaryOf('```\n⏺ Unknown command: /nosuchcmd\n\n❯\n```'), '⏺ Unknown command: /nosuchcmd');
  // a label goes with what follows it; marks and entities are not shown
  assert.equal(summaryOf('**You:**\n> fix &#42;it&#42;\n\nFixed.'), 'You: fix *it*');
  assert.equal(summaryOf('```\n\n```'), '');
  assert.equal(summaryOf('x'.repeat(100)).length, 80);
});

test('an ended group in your "ended" label gets no "ended" tag too; without your label it does', async () => {
  const { createDecor } = await import('../lib/chats/feishu/rooms/decor.mjs');
  const calls = [];
  const ok = async () => ({ code: 0 });
  const client = { im: { v2: {
    tag: { create: async ({ data }) => ({ code: 0, data: { id: `tag-${data.create_tag.name}` } }) },
    bizEntityTagRelation: { create: async ({ data }) => { calls.push(['bind', data.tag_ids[0]]); return ok(); }, update: async ({ data }) => { calls.push(['unbind', data.tag_ids[0]]); return ok(); } },
  } } };
  let state = { chats: {}, tags: { herdrchat: 'tag-herdrchat' } };
  const store = { read: () => JSON.parse(JSON.stringify(state)), write: (s) => { state = JSON.parse(JSON.stringify(s)); } };
  const entryFor = (record) => { let r = record; return { get: () => r, set: (f) => { r = { ...r, ...f }; } }; };
  const quiet = () => {};
  let asYou = true;
  const decor = createDecor({ client, cfg: { botTags: true, userTags: true }, store, log: quiet, logError: (...a) => { throw new Error(a.join(' ')); }, userAuth: {}, asYou: async () => asYou });
  // acting as you: the label says "ended", and an "ended" tag it had comes off
  const labelled = entryFor({ chat: 'oc_1', name: 'herdrchat / x', tag: 'tag-herdrchat', ended: true, endedTag: true });
  await decor.botTags(labelled, 'herdrchat');
  assert.deepEqual(calls, [['unbind', 'tag-ended']]);
  assert.equal(labelled.get().endedTag, false);
  // not acting as you: the tag is the only "ended" there is
  asYou = false;
  calls.length = 0;
  const alone = entryFor({ chat: 'oc_2', name: 'herdrchat / y', tag: 'tag-herdrchat', ended: true, endedTag: false });
  await decor.botTags(alone, 'herdrchat');
  assert.deepEqual(calls, [['bind', 'tag-ended']]);
});
