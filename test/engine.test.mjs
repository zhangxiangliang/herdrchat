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
async function setup(list = [], { logError = (...a) => { throw new Error(a.join(' ')); }, asks = {}, shell = async () => '', ownerActions = {} } = {}) {
  const chat = fakeChat();
  const hc = fakeHc();
  const store = fakeStore();
  const r = fakeReaders();
  const inbox = fs.mkdtempSync(path.join(os.tmpdir(), 'herdrchat-engine-test-'));
  const engine = createEngine({ cfg: { sessions: ['s'] }, chat, hc, readers: r.readers, store, log: quiet, logWarn: quiet, logError, startedAt: '2026-01-01T00:00:00.000Z', inbox, quick: true, asksWaiting: () => Boolean(asks.waiting), askLives: async (s, m, id) => (asks.live ? asks.live(id) : true), shell, ownerActions });
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

test('a multi-select sent from a form presses only the boxes that differ, then Next', async () => {
  const t = terminal('t1', { program: 'fake', agent: true });
  const { chat, hc, engine, done } = await setup([t]);
  const screen = (a, b, c) => `${'─'.repeat(20)}\nWhich colors?\n❯ 1. [${a}] Red\n  2. [${b}] Green\n  3. [${c}] Blue\n`;
  hc.screens.set('s|t1', screen(' ', ' ', '✔'));
  t.status = { app: 'fake-agent', state: 'blocked', kind: 'question' };
  hc.change('s', 'status', t);
  hc.turn('s', 't1', 'blocked');
  await settle(engine);
  const [, , value, message] = chat.of('postDialog')[0].args; // the card, by the id the chat app gave it
  const pressed = hc.pressed.length;
  // on the card: Red ticked, Blue unticked, Green left as it was
  const out = await engine.onAction({ value: { ...value, pick: 'tab' }, message, ticks: { 1: true, 2: false, 3: false } });
  assert.deepEqual(hc.pressed.slice(pressed).map((p) => p.names.join()), ['1', '3', 'tab']);
  assert.match(out.toast.text, /Red/);
  done();
});

test('a click on a card the screen no longer matches turns that card into what it asks now', async () => {
  const t = terminal('t1', { program: 'fake', agent: true });
  const { chat, hc, engine, done } = await setup([t]);
  hc.screens.set('s|t1', 'Do you want to proceed?\n❯ 1. Yes\n  2. No\n\nEsc to cancel');
  t.status = { app: 'fake-agent', state: 'blocked', kind: 'permission' };
  hc.change('s', 'status', t);
  hc.turn('s', 't1', 'blocked');
  await settle(engine);
  const [, , value] = chat.of('postDialog')[0].args;
  const message = `m${chat.calls.indexOf(chat.of('postDialog')[0])}`;
  // the screen moves on to another question before the tap, and that one was seen already
  hc.screens.set('s|t1', 'Ready to submit your answers?\n❯ 1. Submit answers\n  2. Cancel\n\nEsc to cancel');
  hc.turn('s', 't1', 'blocked');
  await settle(engine);
  const cards = chat.of('postDialog').length;
  const pressed = hc.pressed.length;
  const out = await engine.onAction({ value: { ...value, pick: 1, label: 'Yes' }, message });
  assert.equal(hc.pressed.length, pressed, 'nothing pressed on a dialog the card did not show');
  assert.equal(out.card?.kind, 'dialog', 'the card is not closed: it shows the dialog now');
  assert.equal(out.card.dialog.menu.options[0].label, 'Submit answers');
  await settle(engine);
  assert.equal(chat.of('postDialog').length, cards, 'and no extra card');
  const again = await engine.onAction({ value: { ...out.card.value, pick: 1, label: 'Submit answers' }, message });
  assert.deepEqual(hc.pressed.at(-1).names, ['1'], 'the second tap presses it');
  assert.match(again.toast.text, /Submit answers/);
  done();
});

test('a message held on a dialog with no open card posts the card again', async () => {
  const t = terminal('t1', { program: 'fake', agent: true });
  const errors = [];
  const { chat, hc, store, engine, done } = await setup([t], { logError: (...a) => errors.push(a.join(' ')) });
  const room = rooms(store)['s|t1'].chat;
  hc.screens.set('s|t1', 'Do you want to proceed?\n❯ 1. Yes\n  2. No\n\nEsc to cancel');
  t.status = { app: 'fake-agent', state: 'blocked', kind: 'permission' };
  // the first card fails to post: the dialog must not count as posted
  const real = chat.postDialog;
  chat.postDialog = async () => { throw new Error('feishu down'); };
  hc.change('s', 'status', t);
  await settle(engine).catch(() => {});
  chat.postDialog = real;
  const before = chat.of('postDialog').length;
  await engine.onMessage({ room, where: room, message: 'm-in', text: 'are you there?', images: [] });
  await settle(engine);
  assert.equal(chat.of('postDialog').length, before + 1, 'the card is posted when the message is held');
  assert.match(chat.of('reply').at(-1).args[1], /the card above/);
  assert.ok(errors.some((e) => /feishu down/.test(e)), 'the failed post was logged');
  done();
});

test('an agent with its own API: its dialog comes from the API, and a tap answers through it, not the screen', async () => {
  const t = terminal('t1', { program: 'fake', agent: true });
  const { chat, hc, engine, r, done } = await setup([t]);
  const answers = [];
  let waiting = [
    { key: 'f1#q0', kind: 'question', text: 'Which color?', options: [{ n: 1, label: 'Red', value: 'Red' }, { n: 2, label: 'Green', value: 'Green' }, { n: 3, label: 'Type your own answer' }], multi: false, free: { n: 3, label: 'Type your own answer' } },
    { key: 'f1#q1', kind: 'question', text: 'Which size?', options: [{ n: 1, label: 'Small', value: 'S' }, { n: 2, label: 'Large', value: 'L' }], multi: false, free: null },
  ];
  r.reader.dialog = async () => waiting[0] || null;
  r.reader.answer = async (s, a, shown, reply) => { answers.push([shown.key, reply]); waiting = waiting.slice(1); return true; };
  hc.screens.set('s|t1', 'nothing here looks like a menu');
  t.status = { app: 'fake-agent', state: 'blocked', kind: 'question' };
  hc.change('s', 'status', t);
  hc.turn('s', 't1', 'blocked');
  await settle(engine);
  assert.equal(chat.of('postDialog').length, 1, 'a card, though the screen shows no menu');
  const [, shown, value, message] = chat.of('postDialog')[0].args;
  assert.deepEqual(shown.menu.options.map((o) => o.label), ['Red', 'Green', 'Type your own answer']);
  assert.equal(shown.menu.free.label, 'Type your own answer');
  const pressed = hc.pressed.length;
  const out = await engine.onAction({ value: { ...value, pick: 2, label: 'Green' }, message });
  assert.deepEqual(answers[0], ['f1#q0', { pick: 2 }]);
  assert.equal(hc.pressed.length, pressed, 'no key pressed');
  assert.equal(out.card?.kind, 'dialog', 'the card turns into the next question');
  assert.equal(out.card.dialog.menu.options[0].label, 'Small');
  const esc = await engine.onAction({ value: { ...out.card.value, pick: 'esc' }, message });
  assert.deepEqual(answers[1], ['f1#q1', { esc: true }]);
  assert.match(esc.toast.text, /Cancelled/);
  done();
});

test('an agent with its own API: words typed while it asks go in as your own answer, through the API', async () => {
  const t = terminal('t1', { program: 'fake', agent: true });
  const { hc, store, engine, r, done } = await setup([t]);
  const room = store.read().chats['s|t1'].chat;
  const answers = [];
  r.reader.dialog = async () => (answers.length ? null : { key: 'f2#q0', kind: 'question', text: 'Name it?', options: [{ n: 1, label: 'Type your own answer' }], multi: false, free: { n: 1, label: 'Type your own answer' } });
  r.reader.answer = async (s, a, shown, reply) => { answers.push(reply); return true; };
  t.status = { app: 'fake-agent', state: 'blocked', kind: 'question' };
  hc.change('s', 'status', t);
  await settle(engine);
  await engine.onMessage({ room, where: room, message: 'm-in', text: 'call it Bob', images: [] });
  assert.deepEqual(answers, [{ pick: 1, text: 'call it Bob' }]);
  assert.equal(hc.sent.length, 0, 'nothing typed into the terminal');
  done();
});

test('a terminal that already waits when the bot starts gets its card at the first sweep, once', async () => {
  const t = terminal('t1', { program: 'fake', agent: true });
  t.status = { app: 'fake-agent', state: 'blocked', kind: 'permission' };
  const { chat, hc, engine, done } = await setup([t]);
  hc.screens.set('s|t1', 'Do you want to proceed?\n❯ 1. Yes\n  2. No\n\nEsc to cancel');
  engine.tick.sweep();
  await settle(engine);
  assert.equal(chat.of('postDialog').length, 1);
  engine.tick.sweep();
  await settle(engine);
  assert.equal(chat.of('postDialog').length, 1, 'not twice');
  done();
});

test('after a restart, the card already out for a dialog is known: not posted again', async () => {
  const t = terminal('t1', { program: 'fake', agent: true });
  t.status = { app: 'fake-agent', state: 'blocked', kind: 'permission' };
  const { chat, hc, store, engine, r, done } = await setup([t]);
  hc.screens.set('s|t1', 'Do you want to proceed?\n❯ 1. Yes\n  2. No\n\nEsc to cancel');
  engine.tick.sweep();
  await settle(engine);
  assert.equal(chat.of('postDialog').length, 1);
  done();
  // the bot starts again on the same state.json
  const again = createEngine({ cfg: { sessions: ['s'] }, chat, hc, readers: r.readers, store, log: quiet, logWarn: quiet, logError: (...a) => { throw new Error(a.join(' ')); }, startedAt: '2026-01-01T00:00:00.000Z', inbox: os.tmpdir(), quick: true });
  running.add(again);
  const started = again.start();
  hc.snapshot('s', [t]);
  await started;
  again.tick.sweep();
  await settle(again);
  assert.equal(chat.of('postDialog').length, 1, 'the card from before the restart still stands for it');
  again.stop();
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

test('a message sent while it waits on a dialog is held and goes in once the dialog is answered', async () => {
  const t = terminal('t1', { program: 'fake', agent: true });
  const { chat, hc, store, engine, done } = await setup([t]);
  const room = rooms(store)['s|t1'].chat;
  hc.screens.set('s|t1', '──────────\nRun it?\n❯ 1. Yes\n  2. No');
  t.status = { app: 'fake-agent', state: 'blocked', kind: 'permission' };
  await engine.onMessage({ room, where: room, message: 'm-in', text: 'and check the mcp too', images: [] });
  assert.equal(hc.sent.length, 0, 'not typed into the dialog');
  assert.match(chat.of('reply').at(-1).args[1], /goes in once that is answered/);
  t.status = { app: 'fake-agent', state: 'working' };
  hc.change('s', 'status', t);
  await settle(engine);
  assert.equal(hc.sent.at(-1)?.text, 'and check the mcp too');
  done();
});

test('a message that comes while the status still looks blocked but hc says it works goes in at once', async () => {
  const t = terminal('t1', { program: 'fake', agent: true, state: 'blocked' });
  const { hc, store, engine, done } = await setup([t]);
  const room = rooms(store)['s|t1'].chat;
  const view = { ...t, status: { app: 'fake-agent', state: 'blocked' } };
  hc.getTerminal = async () => ({ ...view, status: { app: 'fake-agent', state: 'working' } }); // hc is ahead of the events
  await engine.onMessage({ room, where: room, message: 'm-in', text: 'hello', images: [] });
  assert.equal(hc.sent.at(-1)?.text, 'hello');
  done();
});

test('a held message survives a restart and goes in when the new bot finds it no longer waits', async () => {
  const t = terminal('t1', { program: 'fake', agent: true });
  const first = await setup([t]);
  const room = rooms(first.store)['s|t1'].chat;
  first.hc.screens.set('s|t1', '──────────\nRun it?\n❯ 1. Yes\n  2. No');
  t.status = { app: 'fake-agent', state: 'blocked', kind: 'permission' };
  await first.engine.onMessage({ room, where: room, message: 'm-in', text: 'held across a restart', images: [] });
  assert.equal(first.hc.sent.length, 0);
  first.done();
  // a new bot on the same state, the dialog answered meanwhile
  const chat = fakeChat();
  const hc = fakeHc();
  const r = fakeReaders();
  const engine = createEngine({ cfg: { sessions: ['s'] }, chat, hc, readers: r.readers, store: first.store, log: quiet, logWarn: quiet, logError: quiet, startedAt: '2026-01-01T00:00:00.000Z', inbox: os.tmpdir(), quick: true });
  running.add(engine);
  const started = engine.start();
  hc.snapshot('s', [{ ...t, status: { app: 'fake-agent', state: 'idle' } }]);
  await started;
  await settle(engine);
  assert.equal(hc.sent.at(-1)?.text, 'held across a restart');
  assert.equal(first.store.read().waiting?.['s|t1'], undefined);
  engine.stop();
});

test('a message in a room no terminal has says so', async () => {
  const { chat, engine, done } = await setup([terminal('t1')]);
  await engine.onMessage({ room: 'room-made-by-hand', where: 'room-made-by-hand', message: 'm-in', text: 'hello?', images: [] });
  assert.match(chat.of('reply').at(-1).args[1], /^Not delivered: this room is not a terminal's/);
  done();
});

test('Telegram pins the waiting dialog card and unpins it once answered', async () => {
  const telegram = await import('../lib/chats/telegram/index.mjs');
  const store = fakeStore();
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ method: url.split('/').pop(), body: JSON.parse(opts.body) });
    return { ok: true, json: async () => ({ ok: true, result: true }) };
  };
  try {
    const chat = telegram.create({ cfg: { env: { TELEGRAM_BOT_TOKEN: '1:test', TELEGRAM_OWNER_ID: '42' }, sessions: ['a'] }, store, log: quiet, logWarn: quiet, logError: quiet, stateDir: os.tmpdir(), lane: () => {}, scopeOf: () => 'a' });
    await chat.pin('a|t1', '11', '77');
    assert.deepEqual(chat.pinned(), ['a|t1']);
    await chat.unpin('a|t1');
    assert.deepEqual(chat.pinned(), []);
    assert.deepEqual(calls.map((c) => [c.method, c.body.message_id]), [['pinChatMessage', 77], ['unpinChatMessage', 77]]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('/new names the new tab in herdr-app as asked, by the tab id it gave the terminal', async () => {
  const { chat, hc, engine, done } = await setup([terminal('t1', { space: 'proj' })]);
  await engine.onMessage({ room: null, where: 'dm', message: 'm-in', text: '/new s proj/daily', images: [] });
  await settle(engine);
  assert.equal(hc.ran.labels.where, 'proj / daily');
  assert.deepEqual(hc.named, [{ tabId: hc.ran.labels['herdr.tab'], name: 'daily' }]);
  assert.match(chat.of('reply').at(-1).args[1], /Started `claude` as `t99`.*Its room appears/);
  done();
});

test('an agent\'s hook asks while it works on (Codex): the card goes at its label, stays while it works, and closes when the label goes', async () => {
  const t = terminal('t1', { program: 'fake', agent: true, state: 'working' });
  const { chat, hc, store, engine, r, done } = await setup([t]);
  const room = store.read().chats['s|t1'].chat;
  let waiting = { key: '5-9', kind: 'permission', text: '$ curl example.com', options: [{ n: 1, label: 'Yes' }, { n: 2, label: 'No' }, { n: 3, label: 'Answer in the terminal' }], multi: false, free: null };
  const answers = [];
  r.reader.dialog = async (s, a) => (hc.getTerminal(s, a).then((rec) => rec.labels['herdrchat.ask']) .then((id) => (id ? waiting : null)));
  r.reader.answer = async (s, a, shown, reply) => { answers.push(reply); waiting = null; return true; };
  t.labels = { ...t.labels, 'herdrchat.ask': '5-9' };
  hc.change('s', 'labels', t);
  await settle(engine);
  assert.equal(chat.of('postDialog').length, 1, 'a card though the status says working');
  hc.change('s', 'status', t); // it goes on working: the card stays
  await settle(engine);
  assert.equal(chat.of('closeDialog').length, 0);
  await engine.onMessage({ room, where: room, message: 'm-in', text: 'and then this', images: [] });
  assert.equal(hc.sent.length, 0, 'what you send waits for the answer, as with any dialog');
  const [, , value, message] = chat.of('postDialog')[0].args;
  const tap = await engine.onAction({ value: { ...value, pick: 1, label: 'Yes' }, message });
  assert.deepEqual(answers, [{ pick: 1 }]);
  assert.match(tap.toast.text, /Yes/);
  t.labels = { ...t.labels, 'herdrchat.ask': '' };
  hc.change('s', 'labels', t);
  await settle(engine);
  assert.equal(hc.sent.length, 1, 'the hook is done: what you sent goes in');
  done();
});

test('the hook\'s card closes when its label goes, and a dialog still on the screen gets its own card', async () => {
  const t = terminal('t1', { program: 'fake', agent: true });
  const { chat, hc, engine, r, done } = await setup([t]);
  r.reader.dialog = async (s, a) => ((await hc.getTerminal(s, a)).labels['herdrchat.ask'] ? { key: '6-1', kind: 'permission', text: 'x', options: [{ n: 1, label: 'Yes' }, { n: 2, label: 'No' }], multi: false, free: null } : null);
  r.reader.answer = async () => true;
  t.labels = { ...t.labels, 'herdrchat.ask': '6-1' };
  t.status = { app: 'fake-agent', state: 'blocked', kind: 'permission' };
  hc.change('s', 'labels', t);
  hc.change('s', 'status', t);
  await settle(engine);
  assert.equal(chat.of('postDialog').length, 1, 'one card for the label and the status');
  hc.screens.set('s|t1', 'Do you want to proceed?\n❯ 1. Yes\n  2. No\n\nEsc to cancel');
  t.labels = { ...t.labels, 'herdrchat.ask': '' }; // its time ran out; the prompt is still there
  hc.change('s', 'labels', t);
  await settle(engine);
  assert.equal(chat.of('closeDialog').length, 1);
  assert.equal(chat.of('postDialog').length, 2, 'the screen\'s dialog, to answer by keys');
  assert.equal(chat.of('postDialog')[1].args[1].menu.own, undefined);
  done();
});

test('without the hook on its machine (dialog says false) the screen is read at once', async () => {
  const t = terminal('t1', { program: 'fake', agent: true });
  const { chat, hc, engine, r, done } = await setup([t]);
  let asked = 0;
  r.reader.dialog = async () => { asked += 1; return false; };
  hc.screens.set('s|t1', 'Do you want to proceed?\n❯ 1. Yes\n  2. No\n\nEsc to cancel');
  t.status = { app: 'fake-agent', state: 'blocked', kind: 'permission' };
  hc.change('s', 'status', t);
  await settle(engine);
  assert.equal(asked, 1, 'asked once, not again and again');
  assert.equal(chat.of('postDialog').length, 1);
  done();
});

test('a request its hook left with no terminal (Codex through its background service): its terminal is found and labelled, its card goes, and the label goes with it', async () => {
  const t = terminal('t1', { program: 'fake', agent: true, state: 'working' });
  const asks = { waiting: true, live: () => true };
  const { chat, hc, engine, r, done } = await setup([t], { asks });
  r.reader.strayAsk = async () => (asks.waiting ? '8-3' : null);
  r.reader.dialog = async (s, a) => ((await hc.getTerminal(s, a)).labels['herdrchat.ask'] ? { key: '8-3', kind: 'permission', text: '$ ls', options: [{ n: 1, label: 'Yes' }, { n: 2, label: 'No' }], multi: false, free: null } : null);
  r.reader.answer = async () => true;
  await engine.tick.asks();
  await settle(engine);
  assert.deepEqual(hc.labelled.map((l) => l.labels), [{ 'herdrchat.ask': '8-3' }]);
  assert.equal(chat.of('postDialog').length, 1, 'its card, as for a hook that labelled its terminal itself');
  await engine.tick.asks();
  assert.equal(hc.labelled.length, 1, 'labelled once');
  asks.waiting = false;
  asks.live = () => false; // its hook is done
  await engine.tick.asks();
  await settle(engine);
  assert.deepEqual(hc.labelled.at(-1).labels, { 'herdrchat.ask': '' });
  assert.equal(chat.of('closeDialog').length, 1, 'its card closes');
  done();
});

test('Codex\'s own prompt after its hook (Answer in the terminal) gets one card, whichever of the turn and the label comes first', async () => {
  const t = terminal('t1', { program: 'fake', agent: true, state: 'working' });
  const { chat, hc, engine, r, done } = await setup([t]);
  let answered = false; // as the real reader: an answered request is not asked any more
  r.reader.dialog = async (s, a) => (!answered && (await hc.getTerminal(s, a)).labels['herdrchat.ask'] ? { key: '9-1', kind: 'permission', text: '$ ls', options: [{ n: 1, label: 'Yes' }, { n: 2, label: 'No' }, { n: 3, label: 'Answer in the terminal' }], multi: false, free: null } : null);
  r.reader.answer = async () => { answered = true; return true; };
  t.labels = { ...t.labels, 'herdrchat.ask': '9-1' };
  hc.change('s', 'labels', t);
  await settle(engine);
  const [, , value, message] = chat.of('postDialog')[0].args;
  await engine.onAction({ value: { ...value, pick: 3, label: 'Answer in the terminal' }, message });
  // its own prompt comes up: blocked, and a turn; then the label goes
  hc.screens.set('s|t1', 'Would you like to run the following command?\n\n› 1. Yes, proceed (y)\n  2. No, and tell Codex what to do differently (esc)\n\n  Press enter to confirm or esc to cancel');
  t.status = { app: 'fake-agent', state: 'blocked', kind: 'permission' };
  hc.change('s', 'status', t);
  hc.turn('s', 't1', 'blocked');
  await settle(engine);
  t.labels = { ...t.labels, 'herdrchat.ask': '' };
  hc.change('s', 'labels', t);
  await settle(engine);
  assert.equal(chat.of('postDialog').length, 2, 'the hook\'s card, then one for the prompt on the screen');
  assert.equal(chat.of('postDialog')[1].args[1].menu.own, undefined);
  done();
});

test('a question that leaves the agent idle (Codex\'s async ones) gets its card at the turn\'s end, keeps it while idle, and the tap answers it', async () => {
  const t = terminal('t1', { program: 'fake', agent: true, state: 'working' });
  const { chat, hc, engine, r, done } = await setup([t]);
  let asked = { key: 'q1#0', kind: 'question', idle: true, text: 'Which fruit?', options: [{ n: 1, label: 'Apple' }, { n: 2, label: 'Pear' }, { n: 3, label: 'Type your own answer' }], multi: false, free: { n: 3 } };
  const answers = [];
  r.reader.asksIdle = true;
  r.reader.dialog = async (s, a) => ((await hc.getTerminal(s, a)).status.state === 'working' ? null : asked);
  r.reader.answer = async (s, a, shown, reply) => { answers.push(reply); asked = null; return true; };
  const after = r.reader.after;
  let reads = 0;
  r.reader.after = (...a) => { reads += 1; return after(...a); };
  t.status = { app: 'fake-agent', state: 'done' };
  hc.change('s', 'status', t);
  hc.turn('s', 't1', 'done');
  await settle(engine);
  assert.equal(chat.of('postDialog').length, 1, 'its card, after the turn');
  assert.equal(reads, 1, 'no waiting for a last answer that is not coming');
  t.status = { app: 'fake-agent', state: 'idle' };
  hc.change('s', 'status', t);
  await settle(engine);
  assert.equal(chat.of('closeDialog').length, 0, 'it stays while the agent is idle');
  engine.tick.sweep();
  await settle(engine);
  assert.equal(chat.of('postDialog').length, 1, 'not posted twice');
  const [, , value, message] = chat.of('postDialog')[0].args;
  const tap = await engine.onAction({ value: { ...value, pick: 2, label: 'Pear' }, message });
  assert.deepEqual(answers, [{ pick: 2 }]);
  assert.match(tap.toast.text, /Pear/);
  done();
});

test('a message you send while an idle question waits goes in at once (it is the answer), and its card closes once the agent works', async () => {
  const t = terminal('t1', { program: 'fake', agent: true, state: 'done' });
  const { chat, hc, store, engine, r, done } = await setup([t]);
  const room = store.read().chats['s|t1'].chat;
  r.reader.asksIdle = true;
  r.reader.dialog = async (s, a) => ((await hc.getTerminal(s, a)).status.state === 'working' ? null : { key: 'q2#0', kind: 'question', idle: true, text: 'Which size?', options: [{ n: 1, label: 'Small' }, { n: 2, label: 'Type your own answer' }], multi: false, free: { n: 2 } });
  r.reader.answer = async () => true;
  hc.turn('s', 't1', 'done');
  await settle(engine);
  assert.equal(chat.of('postDialog').length, 1);
  await engine.onMessage({ room, where: room, message: 'm-in', text: 'Medium, please', images: [] });
  assert.deepEqual(hc.sent.map((x) => x.text), ['Medium, please'], 'not held: nothing blocks');
  t.status = { app: 'fake-agent', state: 'working' };
  hc.change('s', 'status', t);
  await settle(engine);
  assert.equal(chat.of('closeDialog').length, 1, 'answered: its card closes');
  done();
});

test('an idle question answered while the bot was not looking: the sweep closes its card', async () => {
  const t = terminal('t1', { program: 'fake', agent: true, state: 'done' });
  const { chat, hc, engine, r, done } = await setup([t]);
  let asked = { key: 'q3#0', kind: 'question', idle: true, text: 'Which colour?', options: [{ n: 1, label: 'Red' }, { n: 2, label: 'Type your own answer' }], multi: false, free: { n: 2 } };
  r.reader.asksIdle = true;
  r.reader.dialog = async () => asked;
  r.reader.answer = async () => true;
  hc.turn('s', 't1', 'done');
  await settle(engine);
  assert.equal(chat.of('postDialog').length, 1);
  engine.tick.sweep();
  await settle(engine);
  assert.equal(chat.of('closeDialog').length, 0, 'still asked: it stays');
  asked = null; // you answered it in the terminal, and no status change was seen
  engine.tick.sweep();
  await settle(engine);
  assert.equal(chat.of('closeDialog').length, 1);
  done();
});

test('under each post: the harness and the model, as its records name them, not as the agent says', async () => {
  const { chat, hc, engine, r, done } = await setup([terminal('t1', { program: 'fake', agent: true })]);
  r.queue('t1', [
    { role: 'meta', model: 'model-a', at: '2026-01-02T00:00:00.000Z', id: 'm' }, // as Codex names it: once, at a turn's start
    { role: 'tool', text: '▸ exec: ls', at: '2026-01-02T00:00:01.000Z', id: 'b' },
    { role: 'ai', text: 'Done.', at: '2026-01-02T00:00:02.000Z', id: 'c', end: true },
  ]);
  hc.turn('s', 't1', 'done');
  await settle(engine);
  assert.deepEqual(chat.of('post').map((c) => [c.args[1], c.args[2].footer]), [['Done.', 'fake-agent · model-a']], 'the model item itself is not shown');
  assert.equal(chat.of('postCard')[0].args[1].footer, 'fake-agent · model-a', 'the live card too');
  assert.equal(chat.of('editCard').at(-1).args[1].footer, 'fake-agent · model-a', 'and once it is closed');
  done();
});

test('a live card that began before the model was named gets it once it is closed', async () => {
  const { chat, hc, store, engine, r, done } = await setup([terminal('t1', { program: 'fake', agent: true })]);
  // a live card posted while only your prompt was read: no model named yet
  const state = store.read();
  state.cursors = { ...state.cursors, 's|t1': { ...state.cursors?.['s|t1'], at: '2026-01-01T00:00:00.000Z', seen: [], reader: 'fake-agent', file: 'log', live: { message: 'm-live', text: '**You:** hi', footer: 'fake-agent' } } };
  store.write(state);
  r.queue('t1', [{ role: 'ai', text: 'Done.', at: '2026-01-02T00:00:02.000Z', id: 'c', end: true, model: 'model-a' }]);
  hc.turn('s', 't1', 'done');
  await settle(engine);
  assert.equal(chat.of('editCard').at(-1).args[1].footer, 'fake-agent · model-a');
  // the next turn names no model: the last one named still stands; an item's own model wins
  r.queue('t1', [{ role: 'ai', text: 'Again.', at: '2026-01-02T00:01:00.000Z', id: 'd', end: true }]);
  hc.turn('s', 't1', 'done');
  await settle(engine);
  assert.equal(chat.of('post').at(-1).args[2].footer, 'fake-agent · model-a');
  r.queue('t1', [{ role: 'ai', text: 'Switched.', at: '2026-01-02T00:02:00.000Z', id: 'e', end: true, model: 'model-b' }]);
  hc.turn('s', 't1', 'done');
  await settle(engine);
  assert.equal(chat.of('post').at(-1).args[2].footer, 'fake-agent · model-b');
  done();
});

test('a post read off the screen says so in its footer, and so does a dialog card', async () => {
  const t = terminal('t1', { program: 'fake', agent: true });
  const { chat, hc, engine, r, done } = await setup([t]);
  r.reader.after = async () => null; // its records are not found
  hc.screens.set('s|t1', 'all done');
  hc.turn('s', 't1', 'done');
  await settle(engine);
  assert.equal(chat.of('post').at(-1).args[2].footer, 'fake-agent · screen');
  hc.screens.set('s|t1', '╭──────╮\n│ Allow?\n│ ❯ 1. Yes\n│   2. No\n╰──────╯');
  t.status = { app: 'fake-agent', state: 'blocked', kind: 'permission' };
  hc.change('s', 'status', t);
  hc.turn('s', 't1', 'blocked');
  await settle(engine);
  assert.equal(chat.of('postDialog').at(-1).args[1].footer, 'fake-agent · screen');
  done();
});

test('a footer is an italic last line in Telegram and a small line in a Feishu card, its marks shown as they are', async () => {
  const telegram = await import('../lib/chats/telegram/index.mjs');
  const { textCard, menuCard } = await import('../lib/chats/feishu/client.mjs');
  const store = fakeStore();
  const state = store.read();
  state.chats = { 'a|t1': { chat: '11', name: 'work / master' } };
  store.write(state);
  const cfg = { env: { TELEGRAM_BOT_TOKEN: '1:test', TELEGRAM_OWNER_ID: '42' }, sessions: ['a'], muted: { all: false, spaces: [] }, silent: { all: false, spaces: [] } };
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    sent.push({ method: url.split('/').pop(), body: JSON.parse(opts.body) });
    return { ok: true, json: async () => ({ ok: true, result: { message_id: sent.length } }) };
  };
  try {
    const chat = telegram.create({ cfg, store, log: quiet, logWarn: quiet, logError: quiet, stateDir: os.tmpdir(), lane: () => {}, scopeOf: () => 'a' });
    await chat.post('11', `${'x'.repeat(3000)}\n${'y'.repeat(3000)}`, { footer: 'codex · gpt_x <1>' });
    await chat.postCard('11', { title: 'Worked', tone: 'closed', markdown: 'hi', footer: 'codex · gpt_x' });
    const texts = sent.filter((x) => x.method === 'sendMessage').map((x) => x.body.text);
    assert.equal(texts.length, 3);
    assert.ok(!texts[0].includes('<i>'), 'only the last piece');
    assert.ok(texts[1].endsWith('\n\n<i>codex · gpt_x &lt;1&gt;</i>'), texts[1].slice(-60));
    assert.ok(texts[2].endsWith('hi\n\n<i>codex · gpt_x</i>'));
  } finally {
    globalThis.fetch = realFetch;
  }
  const foot = (card) => card.body.elements.at(-1);
  assert.deepEqual(foot(textCard('hi', 'Worked', 'closed', 'codex · gpt_x')), { tag: 'markdown', content: 'codex · gpt&#95;x', text_size: 'notation' });
  assert.equal(textCard('hi', 'Worked', 'closed').body.elements.length, 1, 'no footer, no line');
  assert.equal(foot(menuCard({ title: 'Needs you', markdown: 'Allow?', menu: { options: [{ n: 1, label: 'Yes' }], multi: false, free: null }, value: {}, footer: 'codex · screen' })).content, 'codex · screen');
});

test('the footer has the branch of its folder, how full its context is, and the limits, as the reader knows them', async () => {
  const t = terminal('t1', { program: 'fake', agent: true });
  t.foreground.cwd = '/w/proj';
  const shells = [];
  const { chat, hc, engine, r, done } = await setup([t], { shell: async (session, machine, script) => { shells.push(script); return 'feature/x\n'; } });
  r.reader.meter = (s, a, meta) => ({ contextSize: meta.model === 'model-a' ? 200000 : undefined, limits: [{ name: '5-hour', used: 2 }, { name: '7-day', used: 57 }] });
  r.queue('t1', [{ role: 'ai', text: 'Done.', at: '2026-01-02T00:00:02.000Z', id: 'c', end: true, model: 'model-a', context: { used: 50000 } }]);
  hc.turn('s', 't1', 'done');
  await settle(engine);
  assert.equal(chat.of('post').at(-1).args[2].footer, 'fake-agent · model-a · feature/x · context 25% (50k) · 5-hour 2% · 7-day 57%');
  assert.ok(shells[0].includes("cd '/w/proj'"), 'git runs in the terminal\'s folder');
  // limits a reader's own records name (Codex) come before what its meter knows
  r.queue('t1', [{ role: 'meta', limits: [{ name: '7-day', used: 65 }], context: { used: 1000, size: 10000 }, at: '2026-01-02T00:01:00.000Z', id: 'm2' },
    { role: 'ai', text: 'Again.', at: '2026-01-02T00:01:01.000Z', id: 'd', end: true }]);
  hc.turn('s', 't1', 'done');
  await settle(engine);
  assert.equal(chat.of('post').at(-1).args[2].footer, 'fake-agent · model-a · feature/x · context 10% (1k) · 7-day 65%', 'and what was named before still stands');
  done();
});

test('a harness with a long name goes by its short one in the footer', async () => {
  const { chat, hc, engine, r, done } = await setup([terminal('t1', { program: 'fake', agent: true })]);
  r.reader.short = 'fk';
  r.queue('t1', [{ role: 'ai', text: 'Done.', at: '2026-01-02T00:00:02.000Z', id: 'c', end: true, model: 'm' }]);
  hc.turn('s', 't1', 'done');
  await settle(engine);
  assert.equal(chat.of('post').at(-1).args[2].footer, 'fk · m');
  done();
});

test('a message the agent took as its own command, with nothing in its records, gets the screen, not silence', async () => {
  const { chat, hc, store, engine, r, done } = await setup([terminal('t1', { program: 'fake', agent: true })]);
  const room = rooms(store)['s|t1'].chat;
  // only what came on the screen after your message: a long screen folds in the chat and
  // shows its (old) top
  const old = Array.from({ length: 30 }, (_, i) => `old line ${i}`).join('\n');
  hc.screens.set('s|t1', `${old}\n❯ `);
  await engine.onMessage({ room, where: room, message: 'm-in', text: '/update please', images: [] });
  hc.screens.set('s|t1', `${old}\n⏺ Unknown command: /update\n❯ `);
  hc.turn('s', 't1', 'done');
  await settle(engine);
  assert.equal(chat.of('post').at(-1).args[1], '```\n⏺ Unknown command: /update\n❯\n```');
  // a message its records answer posts the answer only
  await engine.onMessage({ room, where: room, message: 'm-2', text: 'hi', images: [] });
  r.queue('t1', [{ role: 'you', text: 'hi', at: '2026-01-02T00:00:00.000Z', id: 'a' }, { role: 'ai', text: 'Hello.', at: '2026-01-02T00:00:01.000Z', id: 'b', end: true }]);
  hc.turn('s', 't1', 'done');
  await settle(engine);
  assert.equal(chat.of('post').at(-1).args[1], 'Hello.');
  const screens = chat.of('post').filter((c) => /Unknown command/.test(c.args[1])).length;
  // and a turn nobody sent anything for posts nothing more
  hc.turn('s', 't1', 'done');
  await settle(engine);
  assert.equal(chat.of('post').filter((c) => /Unknown command/.test(c.args[1])).length, screens);
  done();
});

test('a button on a card to the owner goes to whoever made the card, not to a terminal', async () => {
  const got = [];
  const { engine, done } = await setup([], { ownerActions: { update: (v) => { got.push(v); return { toast: { type: 'info', text: 'Updating' } }; } } });
  const out = await engine.onAction({ value: { update: '9.9.9' }, message: 'm1' });
  assert.deepEqual(got, [{ update: '9.9.9' }]);
  assert.equal(out.toast.text, 'Updating');
  done();
});

test('Telegram: a card to the owner can carry buttons, and a tap gives back the button\'s value', async () => {
  const telegram = await import('../lib/chats/telegram/index.mjs');
  const store = fakeStore();
  const cfg = { env: { TELEGRAM_BOT_TOKEN: '1:test', TELEGRAM_OWNER_ID: '42' }, sessions: ['a'], muted: { all: false, spaces: [] }, silent: { all: false, spaces: [] } };
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    sent.push({ method: url.split('/').pop(), body: JSON.parse(opts.body) });
    return { ok: true, json: async () => ({ ok: true, result: { message_id: sent.length } }) };
  };
  try {
    const chat = telegram.create({ cfg, store, log: quiet, logWarn: quiet, logError: quiet, stateDir: os.tmpdir(), lane: () => {}, scopeOf: () => 'a' });
    await chat.tellOwner({ title: 'New', tone: 'working', markdown: 'x', buttons: [{ label: 'Update to 9.9.9', value: { update: '9.9.9' } }] });
    const button = sent.find((x) => x.method === 'sendMessage').body.reply_markup.inline_keyboard[0][0];
    assert.equal(button.text, 'Update to 9.9.9');
    const [id] = Object.keys(store.read().buttons);
    assert.deepEqual(store.read().buttons[id].picks, { 0: { update: '9.9.9' } });
    assert.equal(button.callback_data, `${id}:0`);
  } finally {
    globalThis.fetch = realFetch;
  }
  const { ownerCard } = await import('../lib/chats/feishu/client.mjs');
  const card = ownerCard({ title: 'New', tone: 'working', markdown: 'x', buttons: [{ label: 'Update to 9.9.9', value: { update: '9.9.9' } }] });
  assert.deepEqual(card.body.elements.at(-1).columns[0].elements[0].behaviors, [{ type: 'callback', value: { update: '9.9.9' } }]);
});

test('a terminal that ends gets its last words and the ended notice in its room', async () => {
  const t = terminal('t1', { program: 'fake', agent: true });
  const { chat, hc, engine, r, done } = await setup([t]);
  r.queue('t1', [{ role: 'ai', text: 'Bye.', at: '2026-01-02T00:00:01.000Z', id: 'a', end: true }]);
  hc.turn('s', 't1', 'done');
  await settle(engine);
  r.reader.rest = async () => [{ role: 'ai', text: 'One more thing.', at: '2026-01-02T00:00:02.000Z', id: 'b', end: true }];
  hc.change('s', 'finished', { ...t, state: 'finished', foreground: null }, { reason: 'exit 0' });
  await settle(engine);
  const posts = chat.of('post').map((c) => c.args[1]);
  assert.ok(posts.includes('One more thing.'), 'what its log still held');
  assert.equal(posts.at(-1), '🔚 **Terminal ended** (exit 0)');
  assert.deepEqual(chat.of('endRoom').map((c) => c.args[0]), ['s|t1']);
  assert.equal(chat.of('openRoom').length, 1, 'no new room for it');
  done();
});
