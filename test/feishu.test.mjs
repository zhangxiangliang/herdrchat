import assert from 'node:assert/strict';
import test from 'node:test';
import { tagName } from '../lib/chats/feishu/client.mjs';
import { chunk, dialogMarkdown, markdownOf, messageParts, summaryOf } from '../lib/chats/feishu/render.mjs';

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
  const { menuCard, ticksOf } = await import('../lib/chats/feishu/render.mjs');
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
  const { menuCard, textCard } = await import('../lib/chats/feishu/render.mjs');
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
  const { doneCard } = await import('../lib/chats/feishu/render.mjs');
  const card = doneCard('✅ Done', 'Run it?', '✔ 1. Yes');
  const note = card.body.elements[1];
  assert.equal(note.content, '1. Yes');
  assert.equal(note.icon.token, 'done_outlined');
});

test('long options are a line each, at the left and as wide as their words; short ones sit side by side', async () => {
  const { menuCard } = await import('../lib/chats/feishu/render.mjs');
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
  assert.equal(summaryOf('You picked Pear, *done*. Or _so_ it seems: ls *.md'), 'You picked Pear, done. Or so it seems: ls *.md');
  assert.equal(summaryOf('```\n\n```'), '');
  assert.equal(summaryOf('x'.repeat(100)).length, 80);
});

test('bot tags: "herdr" on every group, "herdr-ended" too once ended (with /auth or not); a tag from before is taken off for them', async () => {
  const { createDecor } = await import('../lib/chats/feishu/rooms/decor.mjs');
  const calls = [];
  const ok = async () => ({ code: 0 });
  const client = { im: { v2: {
    tag: { create: async ({ data }) => ({ code: 0, data: { id: `tag-${data.create_tag.name}` } }) },
    bizEntityTagRelation: { create: async ({ data }) => { calls.push(['bind', data.tag_ids[0]]); return ok(); }, update: async ({ data }) => { calls.push(['unbind', data.tag_ids[0]]); return ok(); } },
  } } };
  // from before: a tag per session, and "ended"
  let state = { chats: {}, tags: { herdrchat: 'tag-herdrchat', '#ended': 'tag-ended' } };
  const store = { read: () => JSON.parse(JSON.stringify(state)), write: (s) => { state = JSON.parse(JSON.stringify(s)); } };
  const entryFor = (record) => { let r = record; return { get: () => r, set: (f) => { r = { ...r, ...f }; } }; };
  const quiet = () => {};
  const cfg = { botTags: true, userTags: true };
  const decor = createDecor({ client, cfg, store, log: quiet, logError: (...a) => { throw new Error(a.join(' ')); }, userAuth: {}, asYou: async () => true });
  const old = entryFor({ chat: 'oc_1', name: 'herdrchat / x', tag: 'tag-herdrchat', ended: true, endedTag: true });
  await decor.botTags(old);
  assert.deepEqual(calls, [['unbind', 'tag-herdrchat'], ['bind', 'tag-herdr'], ['unbind', 'tag-ended'], ['bind', 'tag-herdr-ended']]);
  assert.deepEqual([old.get().tag, old.get().endedTag], ['tag-herdr', 'tag-herdr-ended']);
  calls.length = 0;
  const live = entryFor({ chat: 'oc_2', name: 'herdrchat / y' });
  await decor.botTags(live);
  assert.deepEqual(calls, [['bind', 'tag-herdr']], 'live: "herdr" only');
  calls.length = 0;
  await decor.botTags(old);
  assert.deepEqual(calls, [], 'nothing to change');
  cfg.botTags = false;
  await decor.botTags(old);
  assert.deepEqual(calls, [['unbind', 'tag-herdr'], ['unbind', 'tag-herdr-ended']], 'off: both off');
});

test('acting as you, every group is in "herdr", an ended one in "herdr-ended" too; one in a label from before is taken out; off takes it out of both', async () => {
  const { createDecor } = await import('../lib/chats/feishu/rooms/decor.mjs');
  const calls = [];
  const labels = { herdrchat: 'ofg_s', 'herdr-ended': 'ofg_e', herdr: 'ofg_all' };
  const userAuth = {
    feedGroups: async () => ({ groups: Object.entries(labels).map(([name, group_id]) => ({ name, group_id })) }),
    createFeedGroup: async () => { throw new Error('none made: all are there'); },
    addToFeedGroup: async (id, chats) => { calls.push(['add', id, ...chats]); },
    removeFromFeedGroup: async (id, chats) => { calls.push(['remove', id, ...chats]); },
  };
  let state = { chats: {} };
  const store = { read: () => JSON.parse(JSON.stringify(state)), write: (s) => { state = JSON.parse(JSON.stringify(s)); } };
  const entryFor = (record) => { let r = record; return { get: () => r, set: (f) => { r = { ...r, ...f }; } }; };
  const quiet = () => {};
  const cfg = { botTags: false, userTags: true };
  const decor = createDecor({ client: {}, cfg, store, log: quiet, logError: (...a) => { throw new Error(a.join(' ')); }, userAuth, asYou: async () => true });
  const live = entryFor({ chat: 'oc_1', name: 'herdrchat / x' });
  await decor.userLabel(live);
  assert.deepEqual(calls, [['add', 'ofg_all', 'oc_1']], 'a live group: "herdr" only');
  calls.length = 0;
  const before = entryFor({ chat: 'oc_2', name: 'herdrchat / y', label: 'herdrchat', inAll: true });
  await decor.userLabel(before);
  assert.deepEqual(calls, [['remove', 'ofg_s', 'oc_2']], 'out of the session label it had');
  assert.equal(before.get().label, null);
  calls.length = 0;
  const ended = entryFor({ ...live.get(), ended: true });
  await decor.userLabel(ended);
  assert.deepEqual(calls, [['add', 'ofg_e', 'oc_1']], 'ended: "ended" too, "herdr" stays');
  calls.length = 0;
  cfg.userTags = false;
  const off = entryFor({ ...ended.get() });
  await decor.userLabel(off);
  assert.deepEqual(calls, [['remove', 'ofg_e', 'oc_1'], ['remove', 'ofg_all', 'oc_1']]);
  assert.deepEqual([off.get().label, off.get().inAll], [null, false]);
});

test('acting as you, no group is pinned (a pin is yours); a pin an older version left is taken off', async () => {
  const { createGroups } = await import('../lib/chats/feishu/rooms/groups.mjs');
  const calls = [];
  const userAuth = new Proxy({}, { get: (_, name) => async (...a) => { calls.push([name, ...a]); } });
  let state = { chats: { 's|t1': { chat: 'oc_1' }, 's|t2': { chat: 'oc_2' } }, pinned: { 's|t2': 'oc_2' } };
  const store = { read: () => JSON.parse(JSON.stringify(state)), write: (s) => { state = JSON.parse(JSON.stringify(s)); } };
  const groups = createGroups({ client: {}, cfg: {}, store, logError: (...a) => { throw new Error(a.join(' ')); }, lane: () => {}, userAuth, asYou: async () => true, decor: {} });
  await groups.pin('s|t1', 'oc_1', 'om_1');
  assert.deepEqual(calls, [], 'nothing pinned');
  assert.deepEqual(groups.pinned(), ['s|t2']);
  await groups.unpin('s|t2');
  assert.deepEqual(calls, [['unpin', 'oc_2']]);
  assert.deepEqual(groups.pinned(), []);
});

test('a post\'s blocks as a Feishu card\'s markdown: a screen in a code block', () => {
  assert.equal(markdownOf([{ kind: 'text', markdown: 'Esc pressed.' }, { kind: 'screen', text: '$ ls\nREADME.md' }]), 'Esc pressed.\n\n```\n$ ls\nREADME.md\n```');
  assert.equal(markdownOf('as it is'), 'as it is');
});

test('a dialog\'s words in a Feishu card: their marks as entities, so they show as they are; a card kept from before (markdown) as it was', () => {
  assert.equal(dialogMarkdown({ body: [{ kind: 'plain', text: 'Run `rm *.tmp` <x>?' }] }), 'Run &#96;rm &#42;.tmp&#96; &#60;x&#62;?');
  assert.equal(dialogMarkdown({ markdown: 'Run it\\?' }), 'Run it\\?');
});

test('your words in a Feishu card: who in bold, then a quote of them as they are', () => {
  assert.equal(markdownOf([{ kind: 'you', text: 'fix *it*\n<b>' }]), '**You:**\n> fix &#42;it&#42;\n> &#60;b&#62;');
  assert.equal(markdownOf([{ kind: 'you', text: 'look', from: 't7 review', answerTo: 't1' }]), '**From t7 review** _(answer: t1)_\n> look');
});

test('a Feishu call that got no answer is marked unreached; one Feishu refused is not', async () => {
  const Lark = await import('@larksuiteoapi/node-sdk');
  const { createClient, updateCard } = await import('../lib/chats/feishu/client.mjs');
  const http = Lark.defaultHttpInstance;
  const real = http.defaults.adapter;
  let answer = null;
  http.defaults.adapter = async (config) => {
    if (config.url.includes('tenant_access_token')) return { data: { code: 0, tenant_access_token: 't', expire: 7200 }, status: 200, headers: {}, config };
    return answer(config);
  };
  try {
    const client = createClient({ appId: 'cli_test', appSecret: 'x' });
    answer = () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND open.feishu.cn'), { code: 'ENOTFOUND', isAxiosError: true }); };
    await assert.rejects(updateCard(client, 'om_1', {}), (err) => err.unreached === true);
    answer = (config) => { throw Object.assign(new Error('Request failed with status code 400'), { isAxiosError: true, response: { status: 400, data: { code: 230001 }, config } }); };
    await assert.rejects(updateCard(client, 'om_1', {}), (err) => !err.unreached);
    answer = (config) => ({ data: { code: 230002, msg: 'no such message' }, status: 200, headers: {}, config });
    await assert.rejects(updateCard(client, 'om_1', {}), (err) => /230002/.test(err.message) && !err.unreached);
  } finally {
    http.defaults.adapter = real;
  }
});

test('a Feishu dialog card once answered shows what was picked as it is, your own words too', async () => {
  const { doneCard } = await import('../lib/chats/feishu/render.mjs');
  const card = doneCard('✅ Done', 'Which city?', '✔ Kyoto <old> *capital*');
  assert.equal(card.body.elements[1].content, 'Kyoto &#60;old&#62; &#42;capital&#42;');
});

test('a Feishu summary keeps the stars of code, and a screen\'s own ``` line stays inside its code block', () => {
  assert.equal(summaryOf('You answered `Kyoto <old> *capital*`, *noted*.'), 'You answered Kyoto <old> *capital*, noted.');
  assert.equal(summaryOf('```\n● Bash(echo \'rm *foo* /tmp/x\')\n```'), "● Bash(echo 'rm *foo* /tmp/x')", 'a screen\'s stars are its own');
  const md = markdownOf([{ kind: 'screen', text: '$ cat a.md\n```js\nok\n```' }]);
  assert.equal(md, '```\n$ cat a.md\n​```js\nok\n​```\n```');
  assert.equal(md.split('\n').filter((l) => /^\s*```/.test(l)).length, 2, 'only its own fences open and close it');
  assert.deepEqual(chunk(md, 6000), [md], 'cut, it is cut as one code block');
});
