import assert from 'node:assert/strict';
import test from 'node:test';
import { groupsOf } from '../lib/chats/overview.mjs';
import { overviewCard, overviewElements } from '../lib/chats/feishu/overview.mjs';

const ROWS = [
  { name: 'alpha / docs', address: 't1', state: 'done', room: 'oc_a' },
  { name: 'beta / 1', address: 'box/t2', state: 'blocked', kind: 'permission', room: 'oc_b' },
  { name: 'alpha / build', address: 't3', state: 'working' },
  { name: 'alpha / shell', address: 't4', program: 'zsh' },
  { name: 'gamma / master', address: 'gamma t1', state: 'idle', room: 'oc_g', note: { kind: 'done', line: 'Fixed it.', at: 1 } },
];

test('the overview\'s shape: what waits for you first, then this computer, machines after, by space and tab', () => {
  const { waiting, groups } = groupsOf(ROWS);
  assert.deepEqual(waiting.map((r) => r.name), ['gamma / master']);
  assert.deepEqual(groups.map((m) => [m.name, m.spaces.map((s) => [s.space, s.tabs.map((t) => t.tab)])]), [
    [null, [['alpha', ['build', 'docs', 'shell']], ['gamma', ['master']]]],
    ['box', [['beta', ['1']]]],
  ]);
});

test('what needs you comes first: needs you, error, working, done, idle, no agent; within one state the one that spoke last; a space by its most urgent tab', () => {
  const row = (name, state, latestAt) => ({ name, address: 't1', state, latestAt, room: name });
  const { groups: machines } = groupsOf([
    row('a / idle', 'idle', 9), row('a / done-old', 'done', 1), row('a / shell', undefined, 0),
    row('b / done-new', 'done', 5), row('b / working', 'working', 2), row('c / asks', 'blocked', 0), row('c / broke', 'error', 3),
  ]);
  assert.deepEqual(machines[0].tabs.map((t) => t.name), ['c / asks', 'c / broke', 'b / working', 'b / done-new', 'a / done-old', 'a / idle', 'a / shell']);
  assert.deepEqual(machines[0].spaces.map((s) => [s.space, s.tabs.map((t) => t.tab)]), [['c', ['asks', 'broke']], ['b', ['working', 'done-new']], ['a', ['done-old', 'idle', 'shell']]]);
});

test('by session, in the order they come (HERDR_SESSIONS\'s), a machine reached over a link after them; a tab in a space named as its session is called by the tab alone', () => {
  const { groups } = groupsOf([
    { name: 'takewalks / master', address: 'takewalks t2', session: 'takewalks', state: 'working' },
    { name: 'herdrchat / master', address: 't1', session: 'herdrchat', state: 'done' },
    { name: 'scratch / x', address: 't9', session: 'herdrchat', state: 'idle' },
    { name: 'tw-worker / T1', address: 'box/t6', session: 'takewalks', state: 'done' },
    { name: 'takewalks / super', address: 'takewalks t3', session: 'takewalks', state: 'idle' },
    { name: 'brain / a', address: 'abox/t1', session: 'herdrchat', state: 'idle' },
  ]);
  assert.deepEqual(groups.map((g) => [g.name, g.tabs.map((t) => t.short)]), [
    ['takewalks', ['master', 'super']],
    ['herdrchat', ['master', 'scratch / x']],
    ['abox', ['brain / a']],
    ['box', ['tw-worker / T1']],
  ]);
  const one = groupsOf([{ name: 'herdrchat / master', address: 't1', session: 'herdrchat', state: 'done' }]);
  assert.deepEqual(one.groups.map((g) => [g.name, g.tabs[0].short]), [[null, 'herdrchat / master']], 'one session alone is this computer');
});

test('the Feishu overview: what waits for you, then a heading and a table per machine, every table Room / State / Latest', () => {
  const at = Date.UTC(2026, 0, 1, 9, 30);
  const rows = ROWS.map((r) => (r.name === 'alpha / build' ? { ...r, latest: 'Building it now', latestAt: at } : r));
  const clock = new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const elements = overviewElements(rows);
  assert.deepEqual(elements.map((e) => e.tag), ['markdown', 'table', 'markdown', 'table', 'markdown', 'table']);
  assert.equal(elements[0].content, '### Waiting for you');
  for (const table of elements.filter((e) => e.tag === 'table')) {
    assert.deepEqual(table.columns.map((c) => [c.name, c.display_name, c.data_type]), [['room', 'Room', 'lark_md'], ['state', 'State', 'options'], ['latest', 'Latest', 'text']]);
    assert.equal(table.page_size, 10);
  }
  const noteClock = new Date(1).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  assert.deepEqual(elements[1].rows, [{ room: '[gamma / master](https://applink.feishu.cn/client/chat/open?openChatId=oc_g)', state: [{ text: 'done', color: 'green' }], latest: `${noteClock}: Fixed it.` }]);
  assert.equal(elements[2].content, '### This computer');
  assert.deepEqual(elements[3].rows, [
    { room: 'alpha / build', state: [{ text: 'working', color: 'blue' }], latest: `${clock}: Building it now` },
    { room: '[alpha / docs](https://applink.feishu.cn/client/chat/open?openChatId=oc_a)', state: [{ text: 'done', color: 'green' }], latest: '' },
    { room: '[gamma / master](https://applink.feishu.cn/client/chat/open?openChatId=oc_g)', state: [{ text: 'idle', color: 'neutral' }], latest: '' },
    { room: 'alpha / shell', state: [{ text: 'zsh', color: 'neutral' }], latest: '' },
  ]);
  assert.equal(elements[4].content, '### box');
  assert.deepEqual(elements[5].rows, [{ room: '[beta / 1](https://applink.feishu.cn/client/chat/open?openChatId=oc_b)', state: [{ text: 'needs you', color: 'orange' }], latest: '' }]);
  const card = overviewCard(ROWS, Date.UTC(2026, 0, 1));
  assert.equal(card.header.template, 'orange');
  assert.equal(card.header.title.content, '1 needs you · herdrchat · 5 terminals');
  assert.equal(card.header.icon.token, 'warning_outlined', 'an icon says what it is, not an emoji');
});

test('a card holds five tables at most, "waiting for you" first: past them the smallest groups are lists, each where it is', () => {
  const rows = [['a', 3], ['b', 1], ['c', 4], ['d', 2], ['e', 5], ['f', 1]].flatMap(([s, n]) => Array.from({ length: n }, (_, i) => ({ name: `${s} / t${i}`, address: `${s} t${i}`, session: s, state: 'idle', room: `oc_${s}${i}` })));
  const kinds = (elements) => elements.filter((e) => e.tag === 'table' || !e.content.startsWith('###')).map((e) => e.tag);
  let elements = overviewElements(rows);
  assert.deepEqual(elements.filter((e) => e.content?.startsWith('###')).map((e) => e.content), ['### a', '### b', '### c', '### d', '### e', '### f']);
  assert.deepEqual(kinds(elements), ['table', 'table', 'table', 'table', 'table', 'markdown'], 'f (1 tab, after b) is the list');
  rows[0].note = { kind: 'done', line: 'x', at: 1 };
  elements = overviewElements(rows);
  assert.deepEqual(kinds(elements).slice(1), ['table', 'markdown', 'table', 'table', 'table', 'markdown'], 'and b too, with "waiting for you"');
  assert.equal(elements.filter((e) => e.tag === 'table').length, 5);
  assert.deepEqual(elements.find((e) => e.content === '### a') && elements[elements.findIndex((e) => e.content === '### a') + 1].rows.map((r) => r.room.split(']')[0]), ['[t0', '[t1', '[t2'], 'in a space named as its session, the tab alone');
});

test('a card holds five tables at most: machines past them are lists too', () => {
  const rows = ['a', 'b', 'c', 'd', 'e', 'f'].map((m) => ({ name: `s${m} / t`, address: `${m}/t1`, state: 'idle', room: `oc_${m}` }));
  let elements = overviewElements(rows);
  assert.equal(elements.filter((e) => e.tag === 'table').length, 5);
  assert.equal(elements.at(-1).content, '- **sf**\n    - [t](https://applink.feishu.cn/client/chat/open?openChatId=oc_f)');
  rows[0].note = { kind: 'done', line: 'x', at: 1 };
  elements = overviewElements(rows);
  assert.equal(elements.filter((e) => e.tag === 'table').length, 5);
  assert.equal(elements.at(-3).content, '- **se**\n    - [t](https://applink.feishu.cn/client/chat/open?openChatId=oc_e)');
});

test('an old overview\'s record is the history, in full: a few lines a note, how and when each was handled; with nothing, it says it is old', async () => {
  const { recordCard } = await import('../lib/chats/feishu/overview.mjs');
  const card = recordCard([{ kind: 'needs', name: 'a / b', room: 'oc_a', line: 'Allow?', at: 1, handled: { how: 'answered', at: 2 } }, { kind: 'done', name: 'c / d', room: null, line: 'Done.', at: 1 }]);
  const [md] = card.body.elements;
  assert.equal(md.tag, 'markdown', 'not a table: a record is read for its details');
  const lines = md.content.split('\n').map((l) => l.replace(/\d\d:\d\d/g, 'HH:MM'));
  assert.deepEqual(lines, [
    "<text_tag color='neutral'>handled</text_tag> **[a / b](https://applink.feishu.cn/client/chat/open?openChatId=oc_a)** · HH:MM",
    "<font color='grey'>Allow?</font>",
    "<font color='grey'>answered · HH:MM</font>",
    "<text_tag color='green'>done</text_tag> **c / d** · HH:MM",
    "<font color='grey'>Done.</font>",
  ]);
  assert.equal(card.config.summary.content, '✓ handled · a / b: Allow?');
  assert.deepEqual(recordCard([]).body.elements, [{ tag: 'markdown', content: 'An old overview. The new one is further down.' }]);
});

test('a name in a table cell or a link keeps its own marks; only what would break a link goes', () => {
  const [, table] = overviewElements([
    { name: 'worker / T1_ABC-2', address: 't6j', state: 'done', room: 'oc_a' },
    { name: 'a*b / [x]', address: 't7', program: 'my_prog <x>' },
  ]);
  assert.deepEqual(table.rows.map((r) => r.room), ['[worker / T1_ABC-2](https://applink.feishu.cn/client/chat/open?openChatId=oc_a)', 'a*b / x']);
});

test('the Telegram overview by session: a session with one space named as itself has its tabs right under it; others a bullet per space', async () => {
  const { overviewHtml } = await import('../lib/chats/telegram/render.mjs');
  const html = overviewHtml([
    { name: 'takewalks / master', address: 'takewalks t2', session: 'takewalks', state: 'working', room: '11' },
    { name: 'herdrchat / master', address: 't1', session: 'herdrchat', state: 'done', room: '12' },
    { name: 'scratch / x', address: 't9', session: 'herdrchat', state: 'idle', room: '13' },
  ], 'bot');
  assert.deepEqual(html.split('\n\n').slice(1), [
    '<b>takewalks</b>\n• <a href="https://t.me/bot/11">master</a> · ⏳ working',
    '<b>herdrchat</b>\n• <b>herdrchat</b>\n      ◦ <a href="https://t.me/bot/12">master</a> · ✅ done\n• <b>scratch</b>\n      ◦ <a href="https://t.me/bot/13">x</a> · idle',
  ]);
});
