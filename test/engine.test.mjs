import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { createEngine } from '../lib/core/engine.mjs';
import { checkChat } from '../lib/chats/contract.mjs';
import { fakeChat, fakeHc, fakeReaders, fakeStore, terminal } from './fakes.mjs';

const quiet = () => {};

// every core a test starts is stopped at the end, even when an assertion failed first
const running = new Set();
after(() => running.forEach((engine) => engine.stop()));

// A core on the fakes, one session "s", started and given `list` as its first snapshot.
async function setup(list = []) {
  const chat = fakeChat();
  const hc = fakeHc();
  const store = fakeStore();
  const r = fakeReaders();
  const inbox = fs.mkdtempSync(path.join(os.tmpdir(), 'herdrchat-engine-test-'));
  const engine = createEngine({ cfg: { sessions: ['s'] }, chat, hc, readers: r.readers, store, log: quiet, logWarn: quiet, logError: (...a) => { throw new Error(a.join(' ')); }, startedAt: '2026-01-01T00:00:00.000Z', inbox, quick: true });
  running.add(engine);
  running.add(engine);
  const started = engine.start();
  hc.snapshot('s', list);
  await started;
  await settle(engine);
  const done = () => { engine.stop(); fs.rmSync(inbox, { recursive: true, force: true }); };
  return { chat, hc, store, engine, r, done };
}

// until every lane is idle (work queues more work, so a few rounds)
async function settle(engine) {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((ok) => setTimeout(ok, 15));
    await engine.tick.idle();
  }
}

const rooms = (store) => store.read().chats;

test('the fake chat app keeps the contract the real ones keep', () => {
  assert.doesNotThrow(() => checkChat(fakeChat()));
  assert.throws(() => checkChat({ name: 'half', ready: () => true }), /does not give: .*openRoom/);
});

test('a tab gets one room, named after where herdr-app shows it', async () => {
  const { chat, store, done } = await setup([terminal('t1')]);
  assert.equal(chat.of('openRoom').length, 1);
  assert.equal(chat.of('openRoom')[0].args[0].name, 'proj / master');
  assert.equal(rooms(store)['s|t1'].tab, 'tb1');
  done();
});

test('a new terminal in the same tab takes over the tab\'s room after the old one ends', async () => {
  const { chat, hc, store, engine, done } = await setup([terminal('t1')]);
  const room = rooms(store)['s|t1'].chat;
  hc.change('s', 'finished', { address: 't1' });
  await settle(engine);
  assert.equal(chat.of('endRoom').length, 1);
  hc.change('s', 'created', terminal('t2'));
  await settle(engine);
  assert.equal(chat.of('openRoom').length, 1, 'no second room');
  assert.equal(rooms(store)['s|t2'].chat, room);
  assert.equal(rooms(store)['s|t1'], undefined);
  assert.ok(chat.of('post').some((c) => c.args[0] === room && /new terminal now \(t2\)/.test(c.args[1])));
  assert.ok(chat.of('reviveRoom').length >= 1);
  done();
});

test('while the old terminal still runs, the new one waits for it, then takes the room', async () => {
  const { chat, hc, store, engine, done } = await setup([terminal('t1')]);
  const room = rooms(store)['s|t1'].chat;
  hc.change('s', 'created', terminal('t2'));
  await settle(engine);
  assert.equal(chat.of('openRoom').length, 1, 'no room for t2 while t1 runs');
  assert.equal(rooms(store)['s|t2'], undefined);
  hc.change('s', 'finished', { address: 't1' });
  await settle(engine);
  assert.equal(rooms(store)['s|t2']?.chat, room);
  assert.equal(chat.of('openRoom').length, 1);
  done();
});

test('a tab that was made again (a new tab id) gets a new room', async () => {
  const { chat, hc, store, engine, done } = await setup([terminal('t1')]);
  hc.change('s', 'finished', { address: 't1' });
  hc.change('s', 'created', terminal('t2', { tabId: 'tb2' }));
  await settle(engine);
  assert.equal(chat.of('openRoom').length, 2);
  assert.notEqual(rooms(store)['s|t2'].chat, rooms(store)['s|t1'].chat);
  done();
});

test('a message to an ended terminal says so plainly and types nothing', async () => {
  const { chat, hc, store, engine, done } = await setup([terminal('t1')]);
  const room = rooms(store)['s|t1'].chat;
  hc.change('s', 'finished', { address: 't1' });
  await settle(engine);
  await engine.onMessage({ room, where: room, message: 'm-in', text: 'hello', images: ['img1'] });
  assert.equal(hc.sent.length, 0);
  assert.equal(chat.of('download').length, 0, 'no image fetched for a terminal that cannot take it');
  assert.match(chat.of('reply').at(-1).args[1], /^Not delivered: this terminal has ended/);
  done();
});

test('a terminal with no agent posts nothing by itself and answers what you type with its tidy screen', async () => {
  const { chat, hc, store, engine, done } = await setup([terminal('t1', { program: 'zsh' })]);
  const room = rooms(store)['s|t1'].chat;
  hc.turn('s', 't1', 'done');
  await settle(engine);
  assert.equal(chat.of('post').length, 0);
  hc.screens.set('s|t1', '\n\n$ ls\nREADME.md\n\n\n\n$ \n\n');
  await engine.onMessage({ room, where: room, message: 'm-in', text: 'ls', images: [] });
  assert.equal(hc.sent[0].text, 'ls');
  assert.equal(chat.of('reply').at(-1).args[1], '```\n$ ls\nREADME.md\n\n$\n```');
  assert.deepEqual(chat.of('markDone').map((c) => c.args), [['m-in', 'r-m-in']]);
  done();
});

test('an agent\'s turn is posted from its reader, and what you sent is not repeated', async () => {
  const { chat, hc, store, engine, r, done } = await setup([terminal('t1', { program: 'fake', agent: true })]);
  const room = rooms(store)['s|t1'].chat;
  await engine.onMessage({ room, where: room, message: 'm-in', text: 'fix it', images: [] });
  r.queue('t1', [
    { role: 'you', text: 'fix it', at: '2026-01-02T00:00:00.000Z', id: 'a' },
    { role: 'ai', text: 'Fixed.', at: '2026-01-02T00:00:01.000Z', id: 'b', end: true },
  ]);
  hc.turn('s', 't1', 'done');
  await settle(engine);
  const posts = chat.of('post').map((c) => c.args[1]);
  assert.deepEqual(posts, ['Fixed.']);
  assert.ok(chat.of('ring').some((c) => c.args[2] === '✅ done'));
  assert.deepEqual(chat.of('markDone').map((c) => c.args[0]), ['m-in']);
  done();
});

test('a stale "blocked" after the agent quit posts no dialog', async () => {
  const t = terminal('t1', { program: 'fake', agent: true });
  const { chat, hc, engine, done } = await setup([t]);
  Object.assign(t, { foreground: { name: 'cswap', argv: ['cswap'] }, status: { app: 'fake-agent', state: 'blocked', kind: 'auth' } });
  hc.screens.set('s|t1', 'switch to which account?\n❯ 1. one\n  2. two');
  hc.change('s', 'status', t);
  hc.turn('s', 't1', 'blocked');
  await settle(engine);
  assert.equal(chat.of('postDialog').length, 0);
  assert.equal(chat.of('post').length, 0);
  done();
});

test('an agent\'s dialog gets one card, and a click presses the option it shows', async () => {
  const t = terminal('t1', { program: 'fake', agent: true });
  const { chat, hc, engine, done } = await setup([t]);
  const dialog = 'Do you want to proceed?\n❯ 1. Yes\n  2. No\n\nEsc to cancel';
  hc.screens.set('s|t1', dialog);
  t.status = { app: 'fake-agent', state: 'blocked', kind: 'permission' };
  hc.change('s', 'status', t);
  hc.turn('s', 't1', 'blocked');
  await settle(engine);
  assert.equal(chat.of('postDialog').length, 1, 'one card for the status and the turn event together');
  const [, shown, value] = chat.of('postDialog')[0].args;
  assert.equal(shown.menu.options.length, 2);
  const message = `m${chat.calls.indexOf(chat.of('postDialog')[0])}`; // the fake's ids are not used by the click
  const out = await engine.onAction({ value: { ...value, pick: 1, label: 'Yes' }, message });
  assert.deepEqual(hc.pressed.at(-1).names, ['1']);
  assert.match(out.toast.text, /1\. Yes/);
  done();
});

test('the Feishu app keeps the chat contract', async () => {
  const feishu = await import('../lib/chats/feishu/index.mjs');
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdrchat-feishu-contract-'));
  const cfg = { appId: 'cli_test', appSecret: 'secret', ownerOpenId: '', sessions: ['s'], muted: { all: true, spaces: [] }, silent: { all: false, spaces: [] }, botTags: true, userTags: true };
  const chat = feishu.create({ cfg, store: fakeStore(), log: quiet, logWarn: quiet, logError: quiet, stateDir, lane: () => {}, scopeOf: () => 's' });
  assert.doesNotThrow(() => checkChat(chat));
  assert.deepEqual(feishu.requires, ['FEISHU_APP_ID', 'FEISHU_APP_SECRET']);
  fs.rmSync(stateDir, { recursive: true, force: true });
});

test('every listed harness reader keeps the reader contract', async () => {
  const { LISTED, checkReader } = await import('../lib/core/readers/index.mjs');
  assert.ok(LISTED.length >= 1);
  for (const reader of LISTED) assert.doesNotThrow(() => checkReader(reader));
  assert.throws(() => checkReader({ app: 'half' }), /does not give: processes, after, rest/);
});

test('the Telegram app keeps the chat contract', async () => {
  const telegram = await import('../lib/chats/telegram/index.mjs');
  const cfg = { env: { TELEGRAM_BOT_TOKEN: '1:test', TELEGRAM_OWNER_ID: '42' }, sessions: ['s'], silent: { all: false, spaces: [] } };
  const chat = telegram.create({ cfg, store: fakeStore(), log: quiet, logWarn: quiet, logError: quiet, stateDir: os.tmpdir(), lane: () => {}, scopeOf: () => 's' });
  assert.doesNotThrow(() => checkChat(chat));
  assert.equal(chat.ready(), true);
  assert.deepEqual(telegram.requires, ['TELEGRAM_BOT_TOKEN']);
});

test('a new room gets the conversation before it: all of it as a file, the newest in a folded post, nothing twice', async () => {
  const chat = fakeChat();
  const hc = fakeHc();
  const store = fakeStore();
  const r = fakeReaders();
  const before = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'ai' : 'you', text: `old ${i} ${'x'.repeat(200)}`, at: `2025-12-31T10:${String(i).padStart(2, '0')}:00.000Z`, id: `o${i}` }));
  r.queue('t1', before);
  r.queue('t1', [{ role: 'ai', text: 'after the start', at: '2026-01-02T00:00:00.000Z', id: 'n1', end: true }]);
  const engine = createEngine({ cfg: { sessions: ['s'] }, chat, hc, readers: r.readers, store, log: quiet, logWarn: quiet, logError: (...a) => { throw new Error(a.join(' ')); }, startedAt: '2026-01-01T00:00:00.000Z', inbox: os.tmpdir(), quick: true });
  running.add(engine);
  const started = engine.start();
  hc.snapshot('s', [terminal('t1', { program: 'fake', agent: true })]);
  await started;
  await settle(engine);
  const [file] = chat.of('postFile').map((c) => c.args[1]);
  assert.match(file.name, /^proj-master-2025-12-31\.md$/);
  const text = file.data.toString();
  assert.match(text, /old 0 /);
  assert.match(text, /old 39 /);
  assert.doesNotMatch(text, /after the start/, 'what came after the start is posted the usual way');
  const [folded] = chat.of('postFolded').map((c) => c.args[1]);
  assert.match(folded.title, /the last \d+ of 40/);
  assert.ok(Buffer.byteLength(folded.markdown) <= chat.foldedBytes);
  assert.match(folded.markdown, /old 39 /);
  engine.tick.sweep();
  await settle(engine);
  assert.ok(chat.of('post').some((c) => c.args[1] === 'after the start'));
  assert.ok(!chat.of('post').some((c) => /old \d+ /.test(c.args[1])), 'nothing from before posted twice');
  engine.tick.sweep();
  await settle(engine);
  assert.equal(chat.of('postFile').length, 1, 'only when the room is made');
  engine.stop();
});

test('/history in a room posts the conversation so far again', async () => {
  const { chat, store, engine, r, done } = await setup([terminal('t1', { program: 'fake', agent: true })]);
  r.queue('t1', [{ role: 'you', text: 'an old question', at: '2025-12-31T10:00:00.000Z', id: 'o1' }]);
  const room = rooms(store)['s|t1'].chat;
  await engine.onMessage({ room, where: room, message: 'm-in', text: '/history', images: [] });
  assert.match(chat.of('postFile').at(-1).args[1].data.toString(), /an old question/);
  done();
});

test('HERDR_HISTORY leaves out what it does not name', async () => {
  const chat = fakeChat();
  const hc = fakeHc();
  const r = fakeReaders();
  r.queue('t1', [{ role: 'you', text: 'old', at: '2025-12-31T10:00:00.000Z', id: 'o1' }]);
  const engine = createEngine({ cfg: { sessions: ['s'], history: { file: false, folded: true } }, chat, hc, readers: r.readers, store: fakeStore(), log: quiet, logWarn: quiet, logError: quiet, startedAt: '2026-01-01T00:00:00.000Z', inbox: os.tmpdir(), quick: true });
  running.add(engine);
  const started = engine.start();
  hc.snapshot('s', [terminal('t1', { program: 'fake', agent: true })]);
  await started;
  await settle(engine);
  assert.equal(chat.of('postFile').length, 0);
  assert.equal(chat.of('postFolded').length, 1);
  assert.doesNotMatch(chat.of('postFolded')[0].args[1].title, /file/);
  engine.stop();
});

test('a numbered list on the screen before the dialog is drawn does not become the card', async () => {
  const t = terminal('t1', { program: 'fake', agent: true });
  const { chat, hc, engine, done } = await setup([t]);
  // what the agent wrote, then a moment later its dialog
  hc.screens.set('s|t1', 'Two things to know:\n1. one thing\n2. another thing');
  t.status = { app: 'fake-agent', state: 'blocked', kind: 'question' };
  hc.turn('s', 't1', 'blocked');
  setTimeout(() => hc.screens.set('s|t1', '──────────────────────\nWhich one?\n❯ 1. Red\n  2. Green\n  3. Blue\n\nEnter to select'), 3);
  await settle(engine);
  const cards = chat.of('postDialog');
  assert.equal(cards.length, 1);
  assert.deepEqual(cards[0].args[1].menu.options.map((o) => o.label), ['Red', 'Green', 'Blue']);
  done();
});

test('in a multi-select, boxes are ticked on the card only and Next sends them all at once', async () => {
  const t = terminal('t1', { program: 'fake', agent: true });
  const { chat, hc, engine, done } = await setup([t]);
  hc.screens.set('s|t1', '──────────────────────\n ← ☐ Sizes  ✔ Submit →\nWhich sizes?\n❯ 1. [ ] Small\n  2. [✔] Medium\n  3. [ ] Large\n  4. Type something.');
  t.status = { app: 'fake-agent', state: 'blocked', kind: 'question' };
  hc.turn('s', 't1', 'blocked');
  await settle(engine);
  const [, , value, message] = chat.of('postDialog')[0].args; // the card, by the id the chat app gave it
  const click = (pick, label) => engine.onAction({ value: { ...value, pick, label }, message });
  try {
  const first = await click(1, 'Small');
  assert.equal(first.card?.kind, 'dialog');
  assert.equal(first.card.dialog.menu.options[0].checked, true);
  const second = await click(2, 'Medium'); // untick
  assert.equal(second.card.dialog.menu.options[1].checked, false);
  await click(3, 'Large');
  assert.equal(hc.pressed.length, 0, 'ticking presses nothing');
  await click('tab');
  assert.deepEqual(hc.pressed.map((p) => p.names[0]), ['1', '2', '3', 'tab']);
  } finally {
    done();
  }
});

test('Telegram posts silently only in muted spaces, and rings only there and never in silent ones', async () => {
  const telegram = await import('../lib/chats/telegram/index.mjs');
  const store = fakeStore();
  const state = store.read();
  state.chats = { 'a|t1': { chat: '11', name: 'work / master' }, 'a|t2': { chat: '12', name: 'tw-worker / job' }, 'a|t3': { chat: '13', name: 'play / x' } };
  store.write(state);
  const cfg = { env: { TELEGRAM_BOT_TOKEN: '1:test', TELEGRAM_OWNER_ID: '42' }, sessions: ['a'], muted: { all: false, spaces: ['work', 'tw-worker'] }, silent: { all: false, spaces: ['tw-worker'] } };
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    sent.push({ method: url.split('/').pop(), body: JSON.parse(opts.body) });
    return { ok: true, json: async () => ({ ok: true, result: { message_id: sent.length } }) };
  };
  try {
    const chat = telegram.create({ cfg, store, log: quiet, logWarn: quiet, logError: quiet, stateDir: os.tmpdir(), lane: () => {}, scopeOf: () => 'a' });
    await chat.post('11', 'in a muted space');
    await chat.post('13', 'in a loud space');
    await chat.ring('a|t1', '1', 'needs you');
    await chat.ring('a|t2', '1', 'needs you');
    await chat.ring('a|t3', '1', 'done');
    const messages = sent.filter((x) => x.method === 'sendMessage').map((x) => [x.body.message_thread_id, x.body.disable_notification, x.body.text]);
    assert.deepEqual(messages, [[11, true, 'in a muted space'], [13, false, 'in a loud space'], [11, false, 'needs you']]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a dialog answered while its screen was read gets no card', async () => {
  const t = terminal('t1', { program: 'fake', agent: true });
  const { chat, hc, engine, done } = await setup([t]);
  hc.screens.set('s|t1', '* Working… (12s)\n\n────────────\n❯ \n────────────');
  t.status = { app: 'fake-agent', state: 'blocked', kind: 'permission' };
  hc.turn('s', 't1', 'blocked');
  setTimeout(() => { t.status = { app: 'fake-agent', state: 'working' }; }, 2); // answered in the terminal
  await settle(engine);
  assert.equal(chat.of('postDialog').length, 0);
  assert.ok(!chat.of('post').some((c) => /Needs you/.test(c.args[1])), 'no "needs you" with a screen that waits on nothing');
  done();
});

test('a message another terminal sent with hc send shows who sent it, not "You"', async () => {
  const { chat, hc, engine, r, done } = await setup([terminal('t1', { program: 'fake', agent: true })]);
  r.queue('t1', [
    { role: 'you', text: '<hc from="t2g master" reach="hc send t2g when done or stuck">Review x.rs</hc>', at: '2026-01-02T00:00:00.000Z', id: 'a' },
    { role: 'you', text: 'and also this <hc from="t7 review">Two bugs</hc>', at: '2026-01-02T00:00:01.000Z', id: 'b' },
    { role: 'ai', text: 'On it.', at: '2026-01-02T00:00:02.000Z', id: 'c', end: true },
  ]);
  hc.turn('s', 't1', 'done');
  await settle(engine);
  // what came before the answer is in the turn's live card, the answer a post
  const text = [...chat.of('postCard').map((c) => c.args[1].markdown), ...chat.of('editCard').map((c) => c.args[1].markdown), ...chat.of('post').map((c) => c.args[1])].join('\n');
  assert.match(text, /\*\*From t2g master\*\* _\(answer: hc send t2g when done or stuck\)_\n> Review x\.rs/);
  assert.match(text, /\*\*You:\*\*\n> and also this\n\n\*\*From t7 review\*\*\n> Two bugs/);
  assert.doesNotMatch(text, /<hc /);
  done();
});

test('a click in a question with previews moves with the arrows and presses Enter', async () => {
  const t = terminal('t1', { program: 'fake', agent: true });
  const { chat, hc, engine, done } = await setup([t]);
  hc.screens.set('s|t1', ['────────────────────', ' ☐ Release', '│ Post it?', '❯ 1. Post it    ┌──────────────┐', '                                  │ preview', '  2. Not yet                       └──────────────'].join('\n'));
  t.status = { app: 'fake-agent', state: 'blocked', kind: 'question' };
  hc.turn('s', 't1', 'blocked');
  await settle(engine);
  const [, , value, message] = chat.of('postDialog')[0].args;
  await engine.onAction({ value: { ...value, pick: 2, label: 'Not yet' }, message });
  assert.deepEqual(hc.pressed.at(-1).names, ['down', 'enter']);
  done();
});
