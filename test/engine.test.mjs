import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { createEngine } from '../lib/core/engine.mjs';
import { checkChat } from '../lib/chats/contract.mjs';
import { footer, PIN_HOME } from '../lib/core/words.mjs';
import { fakeChat, fakeHc, fakeReaders, fakeStore, said, terminal } from './fakes.mjs';

const quiet = () => {};

// every core a test starts is stopped at the end, even when an assertion failed first
const running = new Set();
after(() => running.forEach((engine) => engine.stop()));

// A core on the fakes, one session "s", started and given `list` as its first snapshot.
async function setup(list = [], { logError = (...a) => { throw new Error(a.join(' ')); }, asks = {}, shell = async () => '', ownerActions = {}, cfg = {} } = {}) {
  const chat = fakeChat();
  const hc = fakeHc();
  const store = fakeStore();
  const r = fakeReaders();
  const inbox = fs.mkdtempSync(path.join(os.tmpdir(), 'herdrchat-engine-test-'));
  const engine = createEngine({ cfg: { sessions: ['s'], doneWaitMs: 0, ...cfg }, chat, hc, readers: r.readers, store, log: quiet, logWarn: quiet, logError, startedAt: '2026-01-01T00:00:00.000Z', inbox, quick: true, asksWaiting: () => Boolean(asks.waiting), askLives: async (s, m, id) => (asks.live ? asks.live(id) : true), shell, ownerActions });
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

const AGENT = { program: 'fake', agent: true };

test('a tab gets one room, named after where herdr-app shows it', async () => {
  const { chat, store, done } = await setup([terminal('t1', AGENT)]);
  assert.equal(chat.of('openRoom').length, 1);
  assert.equal(chat.of('openRoom')[0].args[0].name, 'proj / master');
  assert.equal(rooms(store)['s|t1'].tab, 'tb1');
  done();
});

test('a new terminal in the same tab takes over the tab\'s room after the old one ends', async () => {
  const { chat, hc, store, engine, done } = await setup([terminal('t1', AGENT)]);
  const room = rooms(store)['s|t1'].chat;
  hc.change('s', 'finished', { address: 't1' });
  await settle(engine);
  assert.equal(chat.of('endRoom').length, 1);
  hc.change('s', 'created', terminal('t2', AGENT));
  await settle(engine);
  assert.equal(chat.of('openRoom').length, 1, 'no second room');
  assert.equal(rooms(store)['s|t2'].chat, room);
  assert.equal(rooms(store)['s|t1'], undefined);
  assert.ok(chat.of('post').some((c) => c.args[0] === room && /new terminal now \(t2\)/.test(said(c.args[1]))));
  assert.ok(chat.of('reviveRoom').length >= 1);
  done();
});

test('while the old terminal still runs, the new one waits for it, then takes the room', async () => {
  const { chat, hc, store, engine, done } = await setup([terminal('t1', AGENT)]);
  const room = rooms(store)['s|t1'].chat;
  hc.change('s', 'created', terminal('t2', AGENT));
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
  const { chat, hc, store, engine, done } = await setup([terminal('t1', AGENT)]);
  hc.change('s', 'finished', { address: 't1' });
  hc.change('s', 'created', terminal('t2', { ...AGENT, tabId: 'tb2' }));
  await settle(engine);
  assert.equal(chat.of('openRoom').length, 2);
  assert.notEqual(rooms(store)['s|t2'].chat, rooms(store)['s|t1'].chat);
  done();
});

test('a message to an ended terminal says so plainly and types nothing', async () => {
  const { chat, hc, store, engine, done } = await setup([terminal('t1', AGENT)]);
  const room = rooms(store)['s|t1'].chat;
  hc.change('s', 'finished', { address: 't1' });
  await settle(engine);
  await engine.onMessage({ room, where: room, message: 'm-in', text: 'hello', images: ['img1'] });
  assert.equal(hc.sent.length, 0);
  assert.equal(chat.of('download').length, 0, 'no image fetched for a terminal that cannot take it');
  assert.match(chat.of('reply').at(-1).args[1], /^Not delivered: this terminal has ended/);
  done();
});

test('a terminal no agent ever ran in gets no room: its title (the command it runs) never names a group; once an agent runs, it gets one', async () => {
  const shell = terminal('t1', { program: 'zsh' });
  shell.title = 'export TOKEN=abc123';
  const { chat, hc, store, engine, done } = await setup([shell]);
  hc.change('s', 'title', shell);
  await settle(engine);
  assert.equal(chat.of('openRoom').length, 0);
  assert.equal(rooms(store)['s|t1'], undefined);
  hc.snapshot('s', [{ ...terminal('t1', AGENT), title: 'Fix the bug' }]);
  await settle(engine);
  assert.equal(chat.of('openRoom').length, 1);
  assert.equal(rooms(store)['s|t1'].agent, true);
  done();
});

test('with hc alone (no `where` label: no herdr-app): an agent no other terminal started gets a room, named by its folder and its title or hc name; an agent\'s helper (hc\'s parent) gets none', async () => {
  const bare = (address, more) => ({ ...terminal(address, AGENT), labels: {}, cwd: '/srv/api', ...more });
  const { chat, store, done } = await setup([
    bare('t1', { title: '✳ Fix the login' }),
    bare('t2', { name: 'coordinator', title: '' }),
    bare('t3', { parent: 't1' }),
  ]);
  assert.deepEqual(chat.of('openRoom').map((c) => c.args[0].name).sort(), ['api / Fix the login', 'api / coordinator']);
  assert.equal(rooms(store)['s|t3'], undefined, 'a helper is the agent\'s, not yours');
  done();
});

test('a room whose agent quit stays, keeps its name while the shell runs, and answers what you type with the tidy screen', async () => {
  const { chat, hc, store, engine, done } = await setup([terminal('t1', AGENT)]);
  const room = rooms(store)['s|t1'];
  const shell = { ...terminal('t1', { program: 'zsh', tab: '3' }), title: 'curl -H "Authorization: x"' };
  hc.snapshot('s', [shell]);
  hc.change('s', 'title', shell);
  await settle(engine);
  assert.equal(chat.of('renameRoom').length, 0, 'a shell\'s title names nothing');
  assert.equal(chat.of('endRoom').length, 0);
  assert.equal(rooms(store)['s|t1'].name, room.name);
  hc.turn('s', 't1', 'done');
  await settle(engine);
  assert.equal(chat.of('post').length, 0, 'a shell posts nothing by itself');
  hc.screens.set('s|t1', '\n\n$ ls\nREADME.md\n\n\n\n$ \n\n');
  await engine.onMessage({ room: room.chat, where: room.chat, message: 'm-in', text: 'ls', images: [] });
  assert.equal(hc.sent[0].text, 'ls');
  assert.equal(said(chat.of('reply').at(-1).args[1]), '```\n$ ls\nREADME.md\n\n$\n```');
  assert.deepEqual(chat.of('markDone').map((c) => c.args), [['m-in', 'r-m-in']]);
  done();
});

test('a room made before the rule for a terminal no agent ran in is ended, not deleted', async () => {
  const chat = fakeChat();
  const hc = fakeHc();
  const store = fakeStore();
  const state = store.read();
  state.chats = { 's|t1': { chat: 'oc_old', name: 'proj / 2', session: 's', tab: 'tb1' } };
  store.write(state);
  const r = fakeReaders();
  const engine = createEngine({ cfg: { sessions: ['s'], doneWaitMs: 0 }, chat, hc, readers: r.readers, store, log: quiet, logWarn: quiet, logError: quiet, startedAt: '2026-01-01T00:00:00.000Z', inbox: os.tmpdir(), quick: true });
  running.add(engine);
  const started = engine.start();
  hc.snapshot('s', [terminal('t1', { program: 'zsh' })]);
  await started;
  await settle(engine);
  assert.equal(store.read().chats['s|t1'].ended, true);
  assert.deepEqual(chat.of('endRoom').map((c) => c.args[0]), ['s|t1']);
  engine.stop();
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
  const posts = chat.of('post').map((c) => said(c.args[1]));
  assert.deepEqual(posts, ['Fixed.']);
  assert.ok(rung(chat).includes('done'));
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

test('an agent that moves on as your answer lands: its card says what you picked, not "Answered"', async () => {
  const t = terminal('t1', { program: 'fake', agent: true });
  const { chat, hc, engine, r, done } = await setup([t]);
  let waiting = { key: 'f1#q0', kind: 'question', text: 'Which fruit?', options: [{ n: 1, label: 'Apple' }, { n: 2, label: 'Banana' }], multi: false, free: null };
  r.reader.dialog = async () => waiting;
  // as Codex: the keys go in, it is working again before the answer call returns
  r.reader.answer = async () => {
    waiting = null;
    t.status = { app: 'fake-agent', state: 'working' };
    hc.change('s', 'status', t);
    await settle(engine);
    return true;
  };
  t.status = { app: 'fake-agent', state: 'blocked', kind: 'question' };
  hc.change('s', 'status', t);
  hc.turn('s', 't1', 'blocked');
  await settle(engine);
  const [, , value, message] = chat.of('postDialog')[0].args;
  const out = await engine.onAction({ value: { ...value, pick: 2, label: 'Banana' }, message });
  await settle(engine);
  assert.equal(out.card?.done, '✔ 2. Banana');
  assert.equal(chat.of('closeDialog').length, 0, 'nothing closes the card over the click');
  done();
});

test('what an agent says before asking, first thing in a turn, rings no "done": the question rings you', async () => {
  const t = terminal('t1', { program: 'fake', agent: true });
  const { chat, hc, store, engine, r, done } = await setup([t]);
  const room = rooms(store)['s|t1'].chat;
  await engine.onMessage({ room, where: room, message: 'm-in', text: 'pick one for me', images: [] });
  r.queue('t1', [
    { role: 'you', text: 'pick one for me', at: '2026-01-02T00:00:00.000Z', id: 'a' },
    { role: 'tool', text: '▸ AskUserQuestion', at: '2026-01-02T00:00:01.000Z', id: 'b' },
  ]);
  hc.screens.set('s|t1', '╭──────╮\n│ Which one?\n│ ❯ 1. Apple\n│   2. Banana\n╰──────╯');
  t.status = { app: 'fake-agent', state: 'blocked', kind: 'question' };
  hc.change('s', 'status', t);
  hc.turn('s', 't1', 'blocked');
  await settle(engine);
  assert.ok(chat.of('post').some((c) => /AskUserQuestion/.test(said(c.args[1]))), 'what it said is posted');
  assert.deepEqual(rung(chat), ['needs']);
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
  const again = createEngine({ cfg: { sessions: ['s'], doneWaitMs: 0 }, chat, hc, readers: r.readers, store, log: quiet, logWarn: quiet, logError: (...a) => { throw new Error(a.join(' ')); }, startedAt: '2026-01-01T00:00:00.000Z', inbox: os.tmpdir(), quick: true });
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
  const engine = createEngine({ cfg: { sessions: ['s'], doneWaitMs: 0 }, chat, hc, readers: r.readers, store, log: quiet, logWarn: quiet, logError: (...a) => { throw new Error(a.join(' ')); }, startedAt: '2026-01-01T00:00:00.000Z', inbox: os.tmpdir(), quick: true });
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
  assert.ok(chat.of('post').some((c) => said(c.args[1]) === 'after the start'));
  assert.ok(!chat.of('post').some((c) => /old \d+ /.test(said(c.args[1]))), 'nothing from before posted twice');
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
  const engine = createEngine({ cfg: { sessions: ['s'], doneWaitMs: 0, history: { file: false, folded: true } }, chat, hc, readers: r.readers, store: fakeStore(), log: quiet, logWarn: quiet, logError: quiet, startedAt: '2026-01-01T00:00:00.000Z', inbox: os.tmpdir(), quick: true });
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

test('Telegram posts silently only in muted spaces; the overview, in herdr\'s own topic, sounds only when sent anew for a note; an old one becomes a record', async () => {
  const telegram = await import('../lib/chats/telegram/index.mjs');
  const store = fakeStore();
  const state = store.read();
  state.chats = { 'a|t1': { chat: '11', name: 'work / master' }, 'a|t3': { chat: '13', name: 'play / x' } };
  store.write(state);
  const cfg = { env: { TELEGRAM_BOT_TOKEN: '1:test', TELEGRAM_OWNER_ID: '42' }, sessions: ['a'], muted: { all: false, spaces: ['work'] }, silent: { all: false, spaces: [] } };
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    sent.push({ method: url.split('/').pop(), body: JSON.parse(opts.body) });
    const method = url.split('/').pop();
    return { ok: true, json: async () => ({ ok: true, result: method === 'createForumTopic' ? { message_thread_id: 900 } : { message_id: sent.length } }) };
  };
  try {
    const chat = telegram.create({ cfg, store, log: quiet, logWarn: quiet, logError: quiet, stateDir: os.tmpdir(), lane: () => {}, scopeOf: () => 'a' });
    await chat.post('11', 'in a muted space');
    await chat.post('13', 'in a loud space');
    const note = { kind: 'needs', line: 'Run <npm test>?', at: Date.UTC(2026, 0, 1, 12, 0) };
    const rows = [{ name: 'work / master', address: 't1', state: 'blocked', room: '11', note }, { name: 'play / x', address: 't3', state: 'idle', room: '13' }];
    const first = await chat.showOverview(rows.map(({ note: n, ...row }) => row), {});
    const second = await chat.showOverview(rows, { fresh: true, ring: true });
    assert.equal(second.old, first.message);
    await chat.showRecord(second.message, [{ ...note, name: 'work / master', room: '11', handled: { how: 'answered', at: Date.UTC(2026, 0, 1, 12, 3) } }]);
    const messages = sent.filter((x) => x.method === 'sendMessage').map((x) => [x.body.message_thread_id, x.body.disable_notification, x.body.text.split('\n')[0]]);
    assert.deepEqual(messages, [[11, true, 'in a muted space'], [13, false, 'in a loud space'], [900, true, PIN_HOME], [900, true, '<b>⚠️ 1 needs you · herdrchat · 2 terminals</b>'], [900, false, '<b>⚠️ 1 needs you · herdrchat · 2 terminals</b>']], 'the overview in herdr\'s own topic');
    assert.deepEqual(sent.filter((x) => x.method === 'createForumTopic').map((x) => x.body.name), ['📋 herdr'], 'made once, and asks once to be pinned');
    assert.equal(store.read().homeTopic, '900');
    assert.equal(sent.filter((x) => x.method === 'deleteMessage').length, 0, 'nothing deleted');
    const edit = sent.find((x) => x.method === 'editMessageText').body;
    assert.equal(edit.message_id, Number(second.message));
    assert.match(edit.text, /^✓ <b>work \/ master<\/b> · handled · \d\d:00\n<i>Run &lt;npm test&gt;\?<\/i>\n<i>answered · \d\d:03<\/i>$/, 'a record: in full');
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
  assert.ok(!chat.of('post').some((c) => /Needs you/.test(said(c.args[1]))), 'no "needs you" with a screen that waits on nothing');
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
  const text = [...chat.of('postCard').map((c) => said(c.args[1].body)), ...chat.of('editCard').map((c) => said(c.args[1].body)), ...chat.of('post').map((c) => said(c.args[1]))].join('\n');
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
  const engine = createEngine({ cfg: { sessions: ['s'], doneWaitMs: 0 }, chat, hc, readers: r.readers, store: first.store, log: quiet, logWarn: quiet, logError: quiet, startedAt: '2026-01-01T00:00:00.000Z', inbox: os.tmpdir(), quick: true });
  running.add(engine);
  const started = engine.start();
  hc.snapshot('s', [{ ...t, status: { app: 'fake-agent', state: 'idle' } }]);
  await started;
  await settle(engine);
  assert.equal(hc.sent.at(-1)?.text, 'held across a restart');
  assert.equal(first.store.read().waiting?.['s|t1'], undefined);
  engine.stop();
});

test('a message in a room no terminal has says so; a command there is the direct chat\'s', async () => {
  const { chat, engine, done } = await setup([terminal('t1')]);
  await engine.onMessage({ room: 'room-made-by-hand', where: 'room-made-by-hand', message: 'm-in', text: 'hello?', images: [] });
  assert.match(chat.of('reply').at(-1).args[1], /^Not delivered: this room is not a terminal's/);
  // a command there is the direct chat's (Telegram makes a topic of a command sent outside one)
  await engine.onMessage({ room: 'topic-made-by-telegram', where: 'chat:9', message: 'm-2', text: '/usage', images: [] });
  const [where, said] = chat.of('reply').at(-1).args;
  assert.equal(where, 'chat:9');
  assert.match(said, /^No agent is signed in here/);
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

test('/new with words starts it with the labels that say where it is, in the space\'s own id; nothing but hc is run', async () => {
  const { chat, hc, engine, done } = await setup([terminal('t1', { space: 'proj' })]);
  await engine.onMessage({ room: null, where: 'dm', message: 'm-in', text: '/new s proj/daily', images: [] });
  await settle(engine);
  assert.equal(hc.ran.labels.where, 'proj / daily');
  assert.equal(hc.ran.labels['herdr.space'], 'sp1');
  assert.match(hc.ran.labels['herdr.tab'], /^tb[0-9a-f]{32}$/);
  assert.match(chat.of('reply').at(-1).args[1], /Started `claude` as `t99`.*Its room appears/);
  done();
});

// the new-terminal form (engine/create.mjs): the core's side, any app
const formOf = (chat) => chat.of('showForm').at(-1).args[1];
const optionOf = (form, field, label) => form.fields.find((f) => f.name === field).options.find((o) => o.label === label).value;

test('/new alone sends the form: every space there is (each machine\'s by name), a new space on each machine, the agents', async () => {
  const { chat, hc, engine, done } = await setup([
    terminal('t1', { space: 'proj', program: 'fake', agent: true }),
    terminal('t2', { space: 'docs', tabId: 'tb2' }),
  ]);
  hc.cores = async () => ({ self: 'core-s', links: [{ name: 'box', id: 'core-box', state: 'connected' }, { name: 'gone', id: 'core-gone', state: 'connecting' }] });
  await engine.onMessage({ room: null, where: 'dm', message: 'm-in', text: '/new', images: [] });
  await settle(engine);
  const [where, form] = chat.of('showForm').at(-1).args;
  assert.equal(where, 'dm', 'where /new came from');
  assert.deepEqual(form.fields.map((f) => [f.name, f.kind, Boolean(f.optional)]), [['space', 'pick', false], ['name', 'text', true], ['agent', 'pick', false], ['tab', 'text', true], ['folder', 'pick', false], ['path', 'text', true]]);
  assert.deepEqual(form.fields[5].when, { field: 'folder', values: ['other'] });
  assert.deepEqual(form.fields[0].options.map((o) => o.label), ['docs · This computer', 'proj · This computer', '＋ New space on This computer', '＋ New space on box'], 'a machine not connected is not offered');
  assert.deepEqual(form.fields[1].when, { field: 'space', values: ['n0', 'n1'] });
  assert.deepEqual(form.fields[2].options.map((o) => o.value), ['claude', 'codex', 'opencode', 'pi'], 'no shell: it would get no room');
  // the overview's button: the form in the direct chat
  const out = await engine.onAction({ value: { open: 'new' }, message: 'o1', where: null });
  assert.equal(out.toast.type, 'info');
  await settle(engine);
  assert.equal(chat.of('showForm').at(-1).args[0], null);
  done();
});

test('the form sent back starts the terminal: in a space there is, as its other tabs (its id, its folder), the tab named after the agent past the ones it has', async () => {
  const t1 = terminal('t1', { space: 'proj', tab: 'claude', program: 'fake', agent: true });
  t1.foreground.cwd = '/work/proj';
  const { chat, hc, engine, done } = await setup([t1]);
  await engine.onMessage({ room: null, where: 'dm', message: 'm-in', text: '/new', images: [] });
  const form = formOf(chat);
  const out = await engine.onAction({ value: { form: form.id }, message: 'f1', form: { space: optionOf(form, 'space', 'proj'), agent: 'claude', tab: '', folder: '' } });
  assert.deepEqual(out.card.kind, 'look', 'the card says it is starting');
  await settle(engine);
  assert.equal(hc.ran.labels.where, 'proj / claude-2');
  assert.equal(hc.ran.labels['herdr.space'], 'sp1');
  assert.equal(hc.ran.cwd, '/work/proj');
  assert.equal(hc.ran.on, null);
  assert.deepEqual(hc.ran.argv, ['/bin/zsh', '-lc', 'exec claude']);
  const [message, look] = chat.of('editCard').at(-1).args;
  assert.equal(message, 'f1');
  assert.match(look.markdown, /Started `claude` as `t99` in s \/ proj \/ claude-2/);
  const again = await engine.onAction({ value: { form: form.id }, message: 'f1', form: { space: optionOf(form, 'space', 'proj'), agent: 'claude' } });
  assert.equal(again.toast.type, 'warning', 'a form is used once');
  // picks never touched are not sent back by Feishu: their first option
  await engine.onMessage({ room: null, where: 'dm', message: 'm-in2', text: '/new', images: [] });
  await engine.onAction({ value: { form: formOf(chat).id }, message: 'f2', form: { tab: 'x' } });
  await settle(engine);
  assert.deepEqual([hc.ran.labels.where, hc.ran.argv.at(-1)], ['proj / x', 'exec claude']);
  done();
});

test('a new space on a machine reached over a link: hc runs it there, through that machine\'s own shell; a folder under ~ is reached by cd', async () => {
  const { chat, hc, engine, done } = await setup([terminal('t1')]);
  hc.cores = async () => ({ self: 'core-s', links: [{ name: 'box', id: 'core-box', state: 'connected' }] });
  await engine.onMessage({ room: null, where: 'dm', message: 'm-in', text: '/new', images: [] });
  const form = formOf(chat);
  const onBox = optionOf(form, 'space', '＋ New space on box');
  const missing = await engine.onAction({ value: { form: form.id }, message: 'f1', form: { space: onBox, agent: 'codex' } });
  assert.deepEqual([missing.toast.type, missing.card], ['error', undefined], 'a new space needs a name; the form stays to fix');
  const slash = await engine.onAction({ value: { form: form.id }, message: 'f1', form: { space: onBox, name: 'a / b', agent: 'codex' } });
  assert.equal(slash.toast.type, 'error');
  const noPath = await engine.onAction({ value: { form: form.id }, message: 'f1', form: { space: onBox, name: 'api', agent: 'codex', folder: 'other' } });
  assert.equal(noPath.toast.type, 'error', 'another folder needs its path');
  await engine.onAction({ value: { form: form.id }, message: 'f1', form: { space: onBox, name: 'api', agent: 'codex', folder: 'other', path: '~/work/my app' } });
  await settle(engine);
  assert.equal(hc.ran.on, 'box');
  assert.equal(hc.ran.cwd, null, 'no folder of this computer\'s');
  assert.equal(hc.ran.labels.where, 'api / codex');
  assert.match(hc.ran.labels['herdr.space'], /^sp[0-9a-f]{32}$/, 'a new space has an id of its own');
  assert.deepEqual(hc.ran.argv, ['sh', '-c', 'cd ~/\'work/my app\' && exec "${SHELL:-sh}" -lc "$0"', 'exec codex']);
  done();
});

test('the form\'s folder: picked from the ones your terminals use (this computer\'s home as ~), each on its machine; one on another machine than the space is refused', async () => {
  const here = terminal('t1', { space: 'proj', program: 'fake', agent: true });
  here.foreground.cwd = `${os.homedir()}/Code/proj`;
  here.cwd = '/srv/data';
  const there = { ...terminal('box/t2', { space: 'srv', tabId: 'tb2', program: 'fake', agent: true }), cwd: '/home/me/app' };
  there.foreground.cwd = '/home/me/app';
  const { chat, hc, engine, done } = await setup([here, there]);
  hc.cores = async () => ({ self: 'core-s', links: [{ name: 'box', id: 'core-box', state: 'connected' }] });
  await engine.onMessage({ room: null, where: 'dm', message: 'm-in', text: '/new', images: [] });
  const form = formOf(chat);
  assert.deepEqual(form.fields.find((f) => f.name === 'folder').options.map((o) => o.label), [
    'The space\'s folder (a new space: home)', '~/Code/proj · This computer', '/srv/data · This computer', '/home/me/app · box', 'Another folder…',
  ], 'under home first, whatever the home is');
  const wrong = await engine.onAction({ value: { form: form.id }, message: 'f1', form: { space: optionOf(form, 'space', 'proj · This computer'), folder: optionOf(form, 'folder', '/home/me/app · box') } });
  assert.match(wrong.toast.text, /That folder is on box, the space on This computer/);
  await engine.onAction({ value: { form: form.id }, message: 'f1', form: { space: optionOf(form, 'space', 'proj · This computer'), folder: optionOf(form, 'folder', '/srv/data · This computer') } });
  await settle(engine);
  assert.equal(hc.ran.cwd, '/srv/data');
  done();
});

test('a pick changed on the card (Feishu) draws it again: a folder on another machine than the new space goes back to the space\'s own; Start takes the picks', async () => {
  const here = terminal('t1', { space: 'proj', program: 'fake', agent: true });
  here.foreground.cwd = '/work/proj';
  const there = { ...terminal('box/t2', { space: 'srv', tabId: 'tb2', program: 'fake', agent: true }), cwd: '/home/me/app' };
  there.foreground.cwd = '/home/me/app';
  const { chat, hc, engine, done } = await setup([here, there]);
  hc.cores = async () => ({ self: 'core-s', links: [{ name: 'box', id: 'core-box', state: 'connected' }] });
  await engine.onMessage({ room: null, where: 'dm', message: 'm-in', text: '/new', images: [] });
  const form = formOf(chat);
  const { holds } = await import('../lib/chats/form.mjs');
  const folders = (values) => form.fields.find((f) => f.name === 'folder').options.filter((o) => holds(o.when, values)).map((o) => o.label);
  const proj = optionOf(form, 'space', 'proj · This computer');
  assert.deepEqual(folders({ space: proj }), ['The space\'s folder (a new space: home)', '/work/proj · This computer', 'Another folder…'], 'only this computer\'s folders for a space here');
  let out = await engine.onAction({ value: { form: form.id, field: 'folder' }, message: 'f1', option: optionOf(form, 'folder', '/work/proj · This computer') });
  assert.equal(out.card.kind, 'form');
  assert.equal(out.card.picks.folder, optionOf(form, 'folder', '/work/proj · This computer'));
  out = await engine.onAction({ value: { form: form.id, field: 'space' }, message: 'f1', option: optionOf(form, 'space', '＋ New space on box') });
  assert.equal(out.card.picks.folder, 'space', 'a folder of this computer\'s does not go with a space on box');
  out = await engine.onAction({ value: { form: form.id, field: 'folder' }, message: 'f1', option: optionOf(form, 'folder', '/home/me/app · box') });
  await engine.onAction({ value: { form: form.id }, message: 'f1', form: { name: 'web' } });
  await settle(engine);
  assert.deepEqual([hc.ran.on, hc.ran.cwd, hc.ran.labels.where], ['box', '/home/me/app', 'web / claude']);
  done();
});

test('an agent starts through the project\'s own launcher when its folder has one (<agent>.sh, scripts/, script/), looked for on the folder\'s machine; else its command', async () => {
  const asked = [];
  const launchers = { '/work/proj': './scripts/claude.sh', '~/app': './codex.sh' };
  const shell = async (session, machine, script) => {
    asked.push({ machine, script });
    const folder = Object.keys(launchers).find((f) => script.includes(f.startsWith('~') ? `cd ~/'${f.slice(2)}'` : `cd '${f}'`));
    return folder && script.includes(`${launchers[folder].split('/').pop()}`) ? `${launchers[folder]}\n` : '';
  };
  const t1 = terminal('t1', { space: 'proj', program: 'fake', agent: true });
  t1.foreground.cwd = '/work/proj';
  const { chat, hc, engine, done } = await setup([t1], { shell });
  hc.cores = async () => ({ self: 'core-s', links: [{ name: 'box', id: 'core-box', state: 'connected' }] });
  const send = async (form) => {
    await engine.onMessage({ room: null, where: 'dm', message: 'm-in', text: '/new', images: [] });
    const f = formOf(chat);
    await engine.onAction({ value: { form: f.id }, message: 'f1', form: { ...form, space: optionOf(f, 'space', form.space) } });
    await settle(engine);
  };
  await send({ space: 'proj · This computer', agent: 'claude' });
  assert.deepEqual(hc.ran.argv, ['/bin/zsh', '-lc', 'exec ./scripts/claude.sh']);
  assert.equal(asked.at(-1).machine, null);
  assert.match(asked.at(-1).script, /for p in \.\/claude\.sh \.\/scripts\/claude\.sh \.\/script\/claude\.sh;/, 'the folder itself first, then scripts/, then script/');
  assert.match(chat.of('editCard').at(-1).args[1].markdown, /Started `\.\/scripts\/claude\.sh`/, 'the card says which');
  await send({ space: 'proj · This computer', agent: 'pi' });
  assert.deepEqual(hc.ran.argv, ['/bin/zsh', '-lc', 'exec pi'], 'no launcher: the agent\'s own command');
  await send({ space: '＋ New space on box', name: 'api', agent: 'codex', folder: 'other', path: '~/app' });
  assert.equal(asked.at(-1).machine, 'box', 'looked for there');
  assert.deepEqual(hc.ran.argv, ['sh', '-c', 'cd ~/\'app\' && exec "${SHELL:-sh}" -lc "$0"', 'exec ./codex.sh']);
  // what a lookup prints is taken only when it is a launcher's path
  const odd = await setup([t1], { shell: async () => 'rm -rf /; ./x.sh' });
  await odd.engine.onMessage({ room: null, where: 'dm', message: 'm-in', text: '/new', images: [] });
  const f = formOf(odd.chat);
  await odd.engine.onAction({ value: { form: f.id }, message: 'f1', form: { space: optionOf(f, 'space', 'proj'), agent: 'claude' } });
  await settle(odd.engine);
  assert.deepEqual(odd.hc.ran.argv, ['/bin/zsh', '-lc', 'exec claude']);
  odd.done();
  done();
});

test('the form: the tab as named; a start that fails says why on the card', async () => {
  const { chat, hc, engine, done } = await setup([terminal('t1', { space: 'proj' })], { logError: () => {} });
  await engine.onMessage({ room: null, where: 'dm', message: 'm-in', text: '/new', images: [] });
  let form = formOf(chat);
  await engine.onAction({ value: { form: form.id }, message: 'f1', form: { space: optionOf(form, 'space', 'proj'), agent: 'pi', tab: 'logs' } });
  await settle(engine);
  assert.deepEqual(hc.ran.argv, ['/bin/zsh', '-lc', 'exec pi']);
  assert.equal(hc.ran.labels.where, 'proj / logs');
  hc.run = async () => { throw new Error('hc run: no such folder'); };
  await engine.onMessage({ room: null, where: 'dm', message: 'm-in2', text: '/new', images: [] });
  form = formOf(chat);
  await engine.onAction({ value: { form: form.id }, message: 'f2', form: { space: optionOf(form, 'space', 'proj'), agent: 'claude' } });
  await settle(engine);
  const look = chat.of('editCard').at(-1).args[1];
  assert.equal(look.tone, 'bad');
  assert.match(look.markdown, /no such folder/);
  done();
});

test('/usage in the direct chat: the accounts on every machine', async () => {
  const shell = async (s, m, script) => (m === 'box' && /hostname/.test(script) ? 'box\n/home/me' : '');
  const { chat, hc, engine, r, done } = await setup([terminal('t1')], { shell });
  hc.machines = async () => [{ name: 'box', state: 'connected' }, { name: 'gone', state: 'connecting' }];
  r.accounts.set('', [{ id: 'c', app: 'Claude Code', account: 'me@x', limits: [{ name: '5-hour', used: 3 }] }]);
  r.accounts.set('box', [{ id: 'x', app: 'Codex', limits: [], note: 'No limits are named for this sign-in.' }]);
  await engine.onMessage({ room: null, where: 'dm', message: 'm-in', text: '/usage', images: [] });
  await settle(engine);
  assert.equal(chat.of('reply').at(-1).args[1], [
    `**Claude Code** · me@x · on ${os.hostname().split('.')[0]}\n5-hour 3%`,
    '**Codex** · on box\nNo limits are named for this sign-in.',
    'Not reached: gone.',
  ].join('\n\n'));
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
  assert.deepEqual(chat.of('post').map((c) => [said(c.args[1]), footer(c.args[2].footer)]), [['Done.', 'fake-agent · model-a']], 'the model item itself is not shown');
  assert.equal(footer(chat.of('postCard')[0].args[1].footer), 'fake-agent · model-a', 'the live card too');
  assert.equal(footer(chat.of('editCard').at(-1).args[1].footer), 'fake-agent · model-a', 'and once it is closed');
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
  assert.equal(footer(chat.of('editCard').at(-1).args[1].footer), 'fake-agent · model-a');
  // the next turn names no model: the last one named still stands; an item's own model wins
  r.queue('t1', [{ role: 'ai', text: 'Again.', at: '2026-01-02T00:01:00.000Z', id: 'd', end: true }]);
  hc.turn('s', 't1', 'done');
  await settle(engine);
  assert.equal(footer(chat.of('post').at(-1).args[2].footer), 'fake-agent · model-a');
  r.queue('t1', [{ role: 'ai', text: 'Switched.', at: '2026-01-02T00:02:00.000Z', id: 'e', end: true, model: 'model-b' }]);
  hc.turn('s', 't1', 'done');
  await settle(engine);
  assert.equal(footer(chat.of('post').at(-1).args[2].footer), 'fake-agent · model-b');
  done();
});

test('a post read off the screen says so in its footer, and so does a dialog card', async () => {
  const t = terminal('t1', { program: 'fake', agent: true });
  const { chat, hc, engine, r, done } = await setup([t]);
  r.reader.after = async () => null; // its records are not found
  hc.screens.set('s|t1', 'all done');
  hc.turn('s', 't1', 'done');
  await settle(engine);
  assert.equal(footer(chat.of('post').at(-1).args[2].footer), 'fake-agent · screen');
  hc.screens.set('s|t1', '╭──────╮\n│ Allow?\n│ ❯ 1. Yes\n│   2. No\n╰──────╯');
  t.status = { app: 'fake-agent', state: 'blocked', kind: 'permission' };
  hc.change('s', 'status', t);
  hc.turn('s', 't1', 'blocked');
  await settle(engine);
  assert.equal(footer(chat.of('postDialog').at(-1).args[1].footer), 'fake-agent · screen');
  done();
});

test('a footer is an italic last line in Telegram and a small line in a Feishu card, its marks shown as they are', async () => {
  const telegram = await import('../lib/chats/telegram/index.mjs');
  const { textCard, menuCard } = await import('../lib/chats/feishu/render.mjs');
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
    await chat.post('11', `${'x'.repeat(3000)}\n${'y'.repeat(3000)}`, { footer: { app: 'codex', model: 'gpt_x <1>' } });
    await chat.postCard('11', { title: 'Worked', tone: 'closed', markdown: 'hi', footer: { app: 'codex', model: 'gpt_x' } });
    const texts = sent.filter((x) => x.method === 'sendMessage').map((x) => x.body.text);
    assert.equal(texts.length, 3);
    assert.ok(!texts[0].includes('<i>'), 'only the last piece');
    assert.ok(texts[1].endsWith('\n\n<i>codex · gpt_x &lt;1&gt;</i>'), texts[1].slice(-60));
    assert.ok(texts[2].endsWith('hi\n\n<i>codex · gpt_x</i>'));
  } finally {
    globalThis.fetch = realFetch;
  }
  const foot = (card) => card.body.elements.at(-1);
  assert.deepEqual(foot(textCard('hi', 'Worked', 'closed', { app: 'codex', model: 'gpt_x' })), { tag: 'markdown', content: 'codex · gpt&#95;x', text_size: 'notation' });
  assert.equal(textCard('hi', 'Worked', 'closed').body.elements.length, 1, 'no footer, no line');
  assert.equal(foot(menuCard({ title: 'Needs you', markdown: 'Allow?', menu: { options: [{ n: 1, label: 'Yes' }], multi: false, free: null }, value: {}, footer: { app: 'codex', screen: true } })).content, 'codex · screen');
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
  assert.equal(footer(chat.of('post').at(-1).args[2].footer), 'fake-agent · model-a · feature/x · context 25% (50k) · 5-hour 2% · 7-day 57%');
  assert.ok(shells[0].includes("cd '/w/proj'"), 'git runs in the terminal\'s folder');
  // limits a reader's own records name (Codex) come before what its meter knows
  r.queue('t1', [{ role: 'meta', limits: [{ name: '7-day', used: 65 }], context: { used: 1000, size: 10000 }, at: '2026-01-02T00:01:00.000Z', id: 'm2' },
    { role: 'ai', text: 'Again.', at: '2026-01-02T00:01:01.000Z', id: 'd', end: true }]);
  hc.turn('s', 't1', 'done');
  await settle(engine);
  assert.equal(footer(chat.of('post').at(-1).args[2].footer), 'fake-agent · model-a · feature/x · context 10% (1k) · 7-day 65%', 'and what was named before still stands');
  done();
});

test('a harness with a long name goes by its short one in the footer', async () => {
  const { chat, hc, engine, r, done } = await setup([terminal('t1', { program: 'fake', agent: true })]);
  r.reader.short = 'fk';
  r.queue('t1', [{ role: 'ai', text: 'Done.', at: '2026-01-02T00:00:02.000Z', id: 'c', end: true, model: 'm' }]);
  hc.turn('s', 't1', 'done');
  await settle(engine);
  assert.equal(footer(chat.of('post').at(-1).args[2].footer), 'fk · m');
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
  assert.equal(said(chat.of('post').at(-1).args[1]), '```\n⏺ Unknown command: /update\n❯\n```');
  // a message its records answer posts the answer only
  await engine.onMessage({ room, where: room, message: 'm-2', text: 'hi', images: [] });
  r.queue('t1', [{ role: 'you', text: 'hi', at: '2026-01-02T00:00:00.000Z', id: 'a' }, { role: 'ai', text: 'Hello.', at: '2026-01-02T00:00:01.000Z', id: 'b', end: true }]);
  hc.turn('s', 't1', 'done');
  await settle(engine);
  assert.equal(said(chat.of('post').at(-1).args[1]), 'Hello.');
  const screens = chat.of('post').filter((c) => /Unknown command/.test(said(c.args[1]))).length;
  // and a turn nobody sent anything for posts nothing more
  hc.turn('s', 't1', 'done');
  await settle(engine);
  assert.equal(chat.of('post').filter((c) => /Unknown command/.test(said(c.args[1]))).length, screens);
  done();
});

test('a message sent while the last turn\'s end is still being read is the next turn\'s: no screen for it', async () => {
  const t1 = terminal('t1', { program: 'fake', agent: true });
  const { chat, hc, store, engine, done } = await setup([t1]);
  const room = rooms(store)['s|t1'].chat;
  hc.screens.set('s|t1', 'some screen\n❯ ');
  hc.turn('s', 't1', 'done'); // its end is read for a while (nothing new in its records)
  await engine.onMessage({ room, where: room, message: 'm-next', text: 'next', images: [] });
  t1.status = { ...t1.status, state: 'working' }; // it took it at once
  hc.change('s', 'status', t1);
  await settle(engine);
  assert.equal(chat.of('post').filter((c) => /some screen/.test(said(c.args[1]))).length, 0);
  done();
});

test('a message an agent never starts working on (Codex: "Unrecognized command") gets the screen and a note, not silence', async () => {
  const t = terminal('t1', { program: 'fake', agent: true });
  t.status = { app: 'fake-agent', state: 'idle' };
  const { chat, hc, store, engine, r, done } = await setup([t]);
  r.reader.leftInput = (screen, sent) => (screen.includes(`› ${sent}`) ? ['ctrl+c'] : null);
  const room = rooms(store)['s|t1'].chat;
  const old = Array.from({ length: 10 }, (_, i) => `old line ${i}`).join('\n');
  hc.screens.set('s|t1', `${old}\n› `);
  await engine.onMessage({ room, where: room, message: 'm-in', text: '/nosuchcmd', images: [] });
  hc.screens.set('s|t1', `${old}\n• Unrecognized command '/nosuchcmd'.\n› /nosuchcmd`);
  await new Promise((ok) => setTimeout(ok, 60));
  await settle(engine);
  assert.equal(said(chat.of('post').at(-1).args[1]), "```\n• Unrecognized command '/nosuchcmd'.\n› /nosuchcmd\n```\n\nIt did not take this, so its input box was emptied.");
  assert.deepEqual(rung(chat), ['needs']);
  assert.deepEqual(hc.pressed.at(-1).names, ['ctrl+c']);
  // one that starts working is left to its turn's end
  await engine.onMessage({ room, where: room, message: 'm-2', text: 'hi', images: [] });
  t.status = { app: 'fake-agent', state: 'working' };
  hc.change('s', 'status', t);
  await new Promise((ok) => setTimeout(ok, 60));
  await settle(engine);
  assert.equal(rung(chat).length, 1);
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
  const { ownerCard } = await import('../lib/chats/feishu/render.mjs');
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
  const posts = chat.of('post').map((c) => said(c.args[1]));
  assert.ok(posts.includes('One more thing.'), 'what its log still held');
  assert.equal(posts.at(-1), '🔚 **Terminal ended** (exit 0)');
  assert.deepEqual(chat.of('endRoom').map((c) => c.args[0]), ['s|t1']);
  assert.equal(chat.of('openRoom').length, 1, 'no new room for it');
  done();
});

// What Claude Code shows in a folder it was never trusted in, before it starts (made up
// path): no numbers, a cursor; hc has no status for it yet.
const TRUST = ['─'.repeat(40), ' Accessing workspace:', '', ' /work/new-project', '', ' Quick safety check: Is this a project you created or one you trust?', '', ' ❯ No, exit', '   Yes, I trust this folder', '', ' Enter to confirm · Esc to cancel'].join('\n');
const pause = (ms) => new Promise((ok) => setTimeout(ok, ms));

test('an agent that asks before it starts (trust this folder) gets a card; a tap moves with the arrows and presses Enter', async () => {
  const t = terminal('t1', { program: 'fake' }); // its process runs, with no status yet
  const { chat, hc, engine, done } = await setup([]);
  hc.screens.set('s|t1', TRUST);
  hc.change('s', 'created', t);
  await pause(900);
  await settle(engine);
  assert.equal(chat.of('postDialog').length, 1);
  const [, dialog, value, message] = chat.of('postDialog')[0].args;
  assert.equal(dialog.title, '⚠️ Needs you (to start)');
  assert.deepEqual(dialog.menu.options.map((o) => o.label), ['No, exit', 'Yes, I trust this folder']);
  assert.match(said(dialog.body), /Quick safety check/);
  assert.equal(rung(chat).at(-1), 'needs');
  assert.equal(chat.of('showOverview').at(-1).args[0].find((r) => r.address === 't1').state, 'blocked', 'the overview says it needs you, not the program it runs');
  const out = await engine.onAction({ value: { ...value, pick: 2, label: 'Yes, I trust this folder' }, message });
  assert.deepEqual(hc.pressed.at(-1).names, ['down', 'enter']);
  assert.match(out.toast.text, /Yes, I trust this folder/);
  done();
});

test('a message sent while it asks before it starts is held, never typed (Enter would pick "No, exit"), and goes in once it has started', async () => {
  const t = terminal('t1', { program: 'fake' });
  const { chat, hc, store, engine, done } = await setup([]);
  hc.screens.set('s|t1', TRUST);
  hc.change('s', 'created', t);
  await settle(engine);
  const room = rooms(store)['s|t1'].chat;
  await engine.onMessage({ room, where: room, message: 'm-in', text: 'fix the build', images: [] });
  assert.equal(hc.sent.length, 0, 'not typed into what it asks');
  assert.match(chat.of('reply').at(-1).args[1], /goes in once that is answered/);
  assert.equal(chat.of('postDialog').length, 1, 'the card it refers to is there');
  hc.screens.set('s|t1', '❯ ');
  t.status = { app: 'fake-agent', state: 'idle' };
  hc.change('s', 'status', t);
  await settle(engine);
  assert.equal(hc.sent.at(-1)?.text, 'fix the build');
  assert.equal(chat.of('closeDialog').length, 1, 'its card closes as it starts');
  done();
});

test('an agent that ends while it asks before it starts ("No, exit"): its card closes', async () => {
  const t = terminal('t1', { program: 'fake' });
  const { chat, hc, engine, done } = await setup([]);
  hc.screens.set('s|t1', TRUST);
  hc.change('s', 'created', t);
  await pause(900);
  await settle(engine);
  assert.equal(chat.of('postDialog').length, 1);
  hc.change('s', 'finished', { ...t, state: 'finished', foreground: null }, { reason: 'exit 0' });
  await settle(engine);
  assert.equal(chat.of('closeDialog').length, 1);
  assert.equal(chat.of('closeDialog')[0].args[2], 'The terminal has ended.');
  done();
});

test('a shell with a ❯ menu on its screen is not taken for an agent asking before it starts', async () => {
  const t = terminal('t1', { program: 'zsh' });
  const { chat, hc, engine, done } = await setup([]);
  hc.screens.set('s|t1', TRUST);
  hc.change('s', 'created', t);
  await pause(900);
  await settle(engine);
  assert.equal(chat.of('postDialog').length, 0);
  done();
});

test('an agent that asks before it starts gets its card when herdr-app labels its tab only after it was made', async () => {
  const t = terminal('t1', { program: 'fake' });
  const labels = t.labels;
  t.labels = {}; // made by hc run (/new): herdr-app gives it its tab a moment later
  const { chat, hc, engine, done } = await setup([]);
  hc.screens.set('s|t1', TRUST);
  hc.change('s', 'created', t);
  await settle(engine);
  t.labels = labels;
  hc.change('s', 'labels', t);
  await pause(900);
  await settle(engine);
  assert.equal(chat.of('postDialog').length, 1);
  done();
});

test('an agent stopped at its dialog (Esc) goes from asking to waiting without working: its turn\'s end is posted at once', async () => {
  const t = terminal('t1', { program: 'fake', agent: true });
  const { chat, hc, engine, r, done } = await setup([t]);
  hc.screens.set('s|t1', '──────────\nRun it?\n❯ 1. Yes\n  2. No');
  t.status = { app: 'fake-agent', state: 'blocked', kind: 'permission' };
  hc.change('s', 'status', t);
  await settle(engine);
  r.queue('t1', [{ role: 'ai', text: '_(It stopped: Request interrupted by user for tool use)_', at: '2026-01-02T00:00:01.000Z', id: 'i', end: true }]);
  t.status = { app: 'fake-agent', state: 'idle' };
  hc.change('s', 'status', t); // no turn event: it never worked again
  await settle(engine);
  assert.equal(said(chat.of('post').at(-1).args[1]), '_(It stopped: Request interrupted by user for tool use)_');
  assert.equal(rung(chat).at(-1), 'done');
  done();
});

test('a live card kept from before blocks (its text) goes on with what comes, its text kept; a full one is the chat app\'s to say', async () => {
  const { chat, store, engine, r, done } = await setup([terminal('t1', { program: 'fake', agent: true, state: 'working' })]);
  const state = store.read();
  state.cursors = { ...state.cursors, 's|t1': { at: '2026-01-01T00:00:00.000Z', seen: [], reader: 'fake-agent', file: 'log', live: { message: 'm-live', text: '**You:** hi', footer: {} } } };
  store.write(state);
  r.queue('t1', [{ role: 'tool', text: '▸ bash: ls', at: '2026-01-02T00:00:01.000Z', id: 'a' }]);
  engine.tick.live();
  await settle(engine);
  assert.deepEqual(chat.of('editCard').at(-1).args, ['m-live', { title: '⌛️ Working…', tone: 'working', body: [{ kind: 'text', markdown: '**You:** hi' }, { kind: 'plain', text: '▸ bash: ls' }], footer: { app: 'fake-agent', model: undefined, screen: false, branch: '', context: undefined, limits: undefined } }]);
  // the app says it is full: the card is closed and the next one goes on
  chat.bytes = () => chat.liveBytes + 1;
  r.queue('t1', [{ role: 'tool', text: '▸ read: a.txt', at: '2026-01-02T00:00:02.000Z', id: 'b' }]);
  engine.tick.live();
  await settle(engine);
  assert.equal(chat.of('editCard').at(-1).args[1].title, '⌛️ Working… (continued below)');
  assert.deepEqual(chat.of('postCard').at(-1).args[1].body, [{ kind: 'plain', text: '▸ read: a.txt' }]);
  done();
});

test('a pin left on a room that waits on nothing (an unpin that failed, kept by the app) is taken off at the sweep; a waiting one stays', async () => {
  const t1 = terminal('t1', { program: 'fake', agent: true });
  const t2 = terminal('t2', { program: 'fake', agent: true, tab: 'other', tabId: 'tb2', state: 'blocked' });
  const { chat, engine, done } = await setup([t1, t2]);
  chat.pinned = () => ['s|t1', 's|t2'];
  await engine.tick.unpinStale();
  await settle(engine);
  assert.deepEqual(chat.of('unpin').map((c) => c.args[0]), ['s|t1']);
  done();
});

test('a call that fails for a terminal on a machine that is not connected waits for the machine, logged once, no error', async () => {
  const errors = [];
  const t = terminal('box/t1', { program: 'fake', agent: true });
  const { hc, engine, r, done } = await setup([t], { logError: (...a) => errors.push(a.join(' ')) });
  hc.machines = async () => [{ name: 'box', state: 'connecting' }];
  r.reader.after = async () => { throw new Error('hc get box/t1 --json: Command failed: hc get box/t1 --json'); };
  engine.tick.sweep();
  await settle(engine);
  assert.deepEqual(errors, []);
  // connected, it is an error again
  hc.machines = async () => [{ name: 'box', state: 'connected' }];
  engine.laneOf('@box|box/t1', 'sweep', async () => { throw new Error('boom'); });
  await settle(engine);
  assert.match(errors.at(-1), /sweep box\/t1: .*boom/);
  done();
});

test('a live card edit that did not get through (the network) sends no second card: the next edit has it all, and closing it is tried again', async () => {
  const { chat, hc, store, engine, r, done } = await setup([terminal('t1', { program: 'fake', agent: true, state: 'working' })], { logError: () => {} });
  r.queue('t1', [{ role: 'tool', text: '▸ one', at: '2026-01-02T00:00:01.000Z', id: 'a' }]);
  engine.tick.live();
  await settle(engine);
  assert.equal(chat.of('postCard').length, 1);
  const edit = chat.editCard;
  let down = 2;
  chat.editCard = async (...a) => { if (down > 0) { down -= 1; throw Object.assign(new Error('fetch failed'), { unreached: true }); } return edit(...a); };
  r.queue('t1', [{ role: 'tool', text: '▸ two', at: '2026-01-02T00:00:02.000Z', id: 'b' }]);
  engine.tick.live();
  await settle(engine);
  assert.equal(chat.of('postCard').length, 1, 'no second card');
  assert.deepEqual(store.read().cursors['s|t1'].live.body, [{ kind: 'plain', text: '▸ one' }, { kind: 'plain', text: '▸ two' }], 'what was added is kept');
  // the turn ends while the line is still down once: closing it is tried again
  r.queue('t1', [{ role: 'ai', text: 'Done.', at: '2026-01-02T00:00:03.000Z', id: 'c', end: true }]);
  hc.turn('s', 't1', 'done');
  await settle(engine);
  assert.equal(chat.of('postCard').length, 1);
  const closed = chat.of('editCard').at(-1).args[1];
  assert.equal(closed.title, '✅ Worked');
  assert.deepEqual(closed.body, [{ kind: 'plain', text: '▸ one' }, { kind: 'plain', text: '▸ two' }]);
  done();
});

test('an overview that did not get through is shown again later, not left behind', async () => {
  const { chat, hc, engine, done } = await setup([terminal('t1', { agent: true })], { logError: () => {} });
  let down = 1;
  const shown = [];
  chat.showOverview = async (rows) => { if (down > 0) { down -= 1; throw Object.assign(new Error('fetch failed'), { unreached: true }); } shown.push(rows.length); };
  hc.change('s', 'title', { ...terminal('t1', { agent: true }), title: 'x' });
  await pause(200);
  await settle(engine);
  assert.deepEqual(shown, [1], 'shown once the line is back');
  done();
});

// ---------- notes: what rings, the overview sent anew ----------

// the overviews that rang (sent anew for a note), what each rang for (its newest note), the
// rows the last one marks, and how the notes of the records made so far were handled
const rang = (chat) => chat.of('showOverview').filter((c) => c.args[1].ring);
const rung = (chat) => rang(chat).map((c) => c.args[0].filter((r) => r.note).sort((a, b) => b.note.at - a.note.at)[0]?.note.kind);
const marked = (chat) => (chat.of('showOverview').at(-1)?.args[0] || []).filter((r) => r.note).map((r) => [r.name, r.note.kind, r.note.line]);
const records = (chat) => chat.of('showRecord').map((c) => [c.args[0], c.args[1].map((n) => [n.kind, n.line, n.handled?.how || null])]);
// a turn of t1 that ends with an answer
function answer(r, hc, text, id) {
  r.queue('t1', [{ role: 'ai', text, at: `2026-01-02T00:00:0${id}.000Z`, id: `a${id}`, end: true }]);
  hc.turn('s', 't1', 'done');
}
const ASKS = '╭──────╮\n│ Allow ls?\n│ ❯ 1. Yes\n│   2. No\n╰──────╯';

test('a "done" note waits HERDR_DONE_WAIT: your next message in its room meanwhile means you saw it, and nothing rings', async () => {
  const t = terminal('t1', { program: 'fake', agent: true });
  const { chat, hc, store, engine, r, done } = await setup([t], { cfg: { doneWaitMs: 400 } });
  const room = rooms(store)['s|t1'].chat;
  answer(r, hc, '**Fixed** it.\nMore lines.', 1);
  await settle(engine);
  assert.deepEqual(rung(chat), [], 'not yet');
  assert.equal(store.read().notes['s|t1'].line, 'Fixed it.');
  await engine.onMessage({ room, where: room, message: 'm-1', text: 'thanks', images: [] });
  t.status = { ...t.status, state: 'working' }; // it took it
  hc.change('s', 'status', t);
  await pause(500);
  await settle(engine);
  assert.deepEqual(rung(chat), []);
  assert.equal(store.read().notes?.['s|t1'], undefined);
  done();
});

test('a note sends the overview anew, which rings; the one before becomes the record of what it rang for, never recalled; a "done" rings once', async () => {
  const t = terminal('t1', { program: 'fake', agent: true });
  const { chat, hc, store, engine, r, done } = await setup([t], { cfg: { doneWaitMs: 100 } });
  const room = rooms(store)['s|t1'].chat;
  const first = chat.overview;
  answer(r, hc, 'Fixed it.', 1);
  await pause(200);
  await settle(engine);
  assert.deepEqual(rung(chat), ['done']);
  assert.deepEqual(rang(chat)[0].args[0].filter((x) => x.note).map((x) => [x.note.kind, x.note.line]), [['done', 'Fixed it.']], 'the overview that rang says what for');
  assert.deepEqual(marked(chat), [], 'a "done" asks nothing of you: it is not kept waiting');
  assert.equal(store.read().notes?.['s|t1'], undefined);
  assert.deepEqual(records(chat), [[first, []]], 'the first overview rang for nothing: it says it is old');
  const ringing = chat.overview;
  answer(r, hc, 'Done again.', 2);
  await pause(200);
  await settle(engine);
  assert.deepEqual(rung(chat), ['done', 'done']);
  assert.deepEqual(records(chat).at(-1), [ringing, [['done', 'Fixed it.', null]]], 'the overview it replaced: what it rang for');
  const newest = chat.overview;
  await engine.onMessage({ room: null, where: 'dm', message: 'm-3', text: '/ls', images: [] });
  await settle(engine);
  assert.deepEqual(records(chat).at(-1), [newest, [['done', 'Done again.', null]]]);
  void room;
  done();
});

test('a dialog rings at once; answered, its mark goes; a silent space rings nothing', async () => {
  const t = terminal('t1', { program: 'fake', agent: true });
  const { chat, hc, engine, r, done } = await setup([t]);
  answer(r, hc, 'Fixed it.', 1);
  await settle(engine);
  hc.screens.set('s|t1', ASKS);
  t.status = { app: 'fake-agent', state: 'blocked', kind: 'permission' };
  hc.change('s', 'status', t);
  await settle(engine);
  assert.deepEqual(rung(chat), ['done', 'needs']);
  assert.deepEqual(marked(chat), [['proj / master', 'needs', 'Allow ls?']]);
  assert.deepEqual(records(chat).at(-1)[1], [['done', 'Fixed it.', null]]);
  t.status = { app: 'fake-agent', state: 'idle' }; // answered in the terminal
  hc.change('s', 'status', t);
  await settle(engine);
  assert.deepEqual(marked(chat), []);
  done();

  const quietOne = await setup([terminal('t1', { program: 'fake', agent: true })], { cfg: { silent: { all: false, spaces: ['proj'] } } });
  answer(quietOne.r, quietOne.hc, 'Fixed it.', 1);
  await settle(quietOne.engine);
  assert.equal(quietOne.chat.of('post').length, 1);
  assert.deepEqual(rung(quietOne.chat), []);
  quietOne.done();
});

test('while you are in a room (you tapped or wrote there lately), what it asks waits as "done" does: answered meanwhile, nothing rings', async () => {
  const t = terminal('t1', { program: 'fake', agent: true });
  const { chat, hc, engine, done } = await setup([t], { cfg: { doneWaitMs: 400 } });
  hc.screens.set('s|t1', ASKS);
  t.status = { app: 'fake-agent', state: 'blocked', kind: 'permission' };
  hc.change('s', 'status', t);
  await settle(engine);
  assert.deepEqual(rung(chat), ['needs'], 'not there: at once');
  const [, , value, message] = chat.of('postDialog').at(-1).args;
  await engine.onAction({ value: { ...value, pick: 1, label: 'Yes' }, message });
  t.status = { app: 'fake-agent', state: 'working' };
  hc.change('s', 'status', t);
  await settle(engine);
  hc.screens.set('s|t1', ASKS.replace('ls', 'rm'));
  t.status = { app: 'fake-agent', state: 'blocked', kind: 'permission' };
  hc.change('s', 'status', t);
  hc.turn('s', 't1', 'blocked');
  await settle(engine);
  assert.equal(chat.of('postDialog').length, 2);
  assert.deepEqual(rung(chat), ['needs'], 'you just tapped there: it waits');
  t.status = { app: 'fake-agent', state: 'working' }; // answered meanwhile
  hc.change('s', 'status', t);
  await pause(500);
  await settle(engine);
  assert.deepEqual(rung(chat), ['needs']);
  hc.screens.set('s|t1', ASKS.replace('ls', 'mv'));
  t.status = { app: 'fake-agent', state: 'blocked', kind: 'permission' };
  hc.change('s', 'status', t);
  hc.turn('s', 't1', 'blocked');
  await pause(500);
  await settle(engine);
  assert.deepEqual([chat.of('postDialog').length, rung(chat)], [3, ['needs', 'needs']], 'not answered: it rings once it waited');
  done();
});

test('a dialog answered before its overview went out rings nothing', async () => {
  const t = terminal('t1', { program: 'fake', agent: true });
  const { chat, hc, engine, done } = await setup([t]);
  hc.screens.set('s|t1', ASKS);
  // answered the moment its card is out, before the overview's wait is over
  const pin = chat.pin;
  chat.pin = async (...a) => {
    await pin(...a);
    t.status = { app: 'fake-agent', state: 'working' };
    hc.change('s', 'status', t);
  };
  t.status = { app: 'fake-agent', state: 'blocked', kind: 'permission' };
  hc.change('s', 'status', t);
  await settle(engine);
  assert.equal(chat.of('postDialog').length, 1, 'its card went out');
  assert.equal(rang(chat).length, 0);
  assert.deepEqual(marked(chat), []);
  done();
});

test('after a restart, a note that waited rings, a "needs you" whose terminal moved on is handled in its record, and a failed record edit is tried again', async () => {
  const t1 = terminal('t1', { program: 'fake', agent: true });
  const t2 = terminal('t2', { program: 'fake', agent: true, tab: 'b', tabId: 'tb2' });
  const first = await setup([t1, t2]);
  first.done();
  const state = first.store.read();
  const c = (k) => state.chats[k];
  const asked = { kind: 'needs', name: c('s|t2').name, room: c('s|t2').chat, line: 'Allow?', at: 2 };
  state.notes = {
    's|t1': { kind: 'done', name: c('s|t1').name, room: c('s|t1').chat, line: 'waited', at: 3, due: 1 },
    's|t2': { ...asked, asks: true, out: true, shown: 'o-old' },
  };
  state.records = { 'o-old': [{ k: 's|t2', ...asked }], 'o-older': [] };
  state.recordEdits = ['o-older'];
  first.store.write(state);
  const chat = fakeChat();
  const hc = fakeHc();
  const r = fakeReaders();
  const engine = createEngine({ cfg: { sessions: ['s'], doneWaitMs: 0 }, chat, hc, readers: r.readers, store: first.store, log: quiet, logWarn: quiet, logError: quiet, startedAt: '2026-01-01T00:00:00.000Z', inbox: os.tmpdir(), quick: true });
  running.add(engine);
  const started = engine.start();
  hc.snapshot('s', [t1, t2]);
  await started;
  await pause(60);
  await settle(engine);
  assert.deepEqual(rung(chat), ['done']);
  assert.deepEqual(marked(chat), [], 'it rang; a "done" is not kept waiting');
  const made = records(chat);
  assert.deepEqual(made.find(([m]) => m === 'o-old'), ['o-old', [['needs', 'Allow?', 'answered']]]);
  assert.deepEqual(made.find(([m]) => m === 'o-older'), ['o-older', []]);
  assert.equal(first.store.read().recordEdits, undefined);
  engine.stop();
});

test('/kill in a terminal\'s room ends that terminal, with no address to give', async () => {
  const t = terminal('t1', { program: 'fake', agent: true });
  const { chat, hc, store, engine, done } = await setup([t]);
  const room = rooms(store)['s|t1'].chat;
  await engine.onMessage({ room, where: room, message: 'm-1', text: '/kill', images: [] });
  await settle(engine);
  assert.deepEqual(hc.killed, [{ session: 's', address: 't1' }]);
  assert.deepEqual(hc.sent, [], 'not typed into it');
  assert.match(said(chat.of('reply').at(-1).args[1]), /Ended `t1`/);
  done();
});

test('a reader that fails on another machine posts no screen: the sweep posts what it said, once, when that machine answers', async () => {
  const t = terminal('box/t1', { program: 'fake', agent: true });
  // errors only logged, as in the bot (the tests' own logError throws)
  const { chat, hc, engine, r, done } = await setup([t], { logError: quiet });
  const after = r.reader.after;
  let down = true;
  r.reader.after = async (...a) => {
    if (down) throw new Error('hc exec --on box: {"error":{"kind":"unavailable"}}');
    return after(...a);
  };
  hc.screens.set('s|box/t1', 'some screen\n❯ ');
  r.queue('box/t1', [{ role: 'ai', text: 'Found it.', at: '2026-01-02T00:00:01.000Z', id: 'a', end: true }]);
  hc.turn('s', 'box/t1', 'done');
  await settle(engine);
  assert.deepEqual(chat.of('post').map((c) => said(c.args[1])), [], 'no screen while its machine does not answer');
  down = false;
  engine.tick.sweep();
  await settle(engine);
  assert.deepEqual(chat.of('post').map((c) => said(c.args[1])), ['Found it.']);
  done();
});

test('the overview shows each room\'s latest line, in a silent space too', async () => {
  const t = terminal('t1', { program: 'fake', agent: true });
  const { chat, hc, engine, r, done } = await setup([t], { cfg: { silent: { all: true, spaces: [] } } });
  answer(r, hc, '**Fixed** it.\nMore.', 1);
  await settle(engine);
  const row = () => chat.of('showOverview').at(-1).args[0].find((x) => x.address === 't1');
  assert.equal(row().latest, 'Fixed it.');
  assert.equal(rang(chat).length, 0, 'silent: nothing rings');
  done();
});

test('the overview leaves out a terminal with no agent (a shell, a server); one with an agent stays', async () => {
  const shell = terminal('t1', { space: 'a', program: 'bash' });
  const server = terminal('t2', { space: 'b', tabId: 'tb2', program: 'node' });
  const agent = terminal('t3', { space: 'c', tabId: 'tb3', program: 'fake', agent: true });
  const { chat, engine, done } = await setup([shell, server, agent]);
  engine.tick.sweep();
  await settle(engine);
  assert.deepEqual(chat.of('showOverview').at(-1).args[0].map((x) => x.address), ['t3']);
  done();
});

test('a room with no latest line gets the last answer in its agent\'s records, read until one is found', async () => {
  const t = terminal('t1', { program: 'fake', agent: true });
  const { chat, engine, r, done } = await setup([t]);
  // from before the bot started: in its records, never posted
  r.queue('t1', [
    { role: 'you', text: 'old question', at: '2025-12-31T10:00:00.000Z', id: 'q' },
    { role: 'ai', text: '**Old** answer.\nMore.', at: '2025-12-31T10:00:01.000Z', id: 'a' },
  ]);
  let reads = 0;
  const after = r.reader.after;
  r.reader.after = async (...a) => { reads += 1; return after(...a); };
  engine.tick.sweep();
  await settle(engine);
  const row = () => chat.of('showOverview').at(-1).args[0].find((x) => x.address === 't1');
  assert.equal(row().latest, 'Old answer.');
  const before = reads;
  engine.tick.sweep();
  await settle(engine);
  assert.equal(reads - before, 1, 'the next sweep reads only what is new, not the whole record again');
  done();
});

test('a note\'s line has the marks of its markdown taken off, a word\'s own _ kept', async () => {
  const { lineOf } = await import('../lib/core/engine/notes.mjs');
  assert.equal(lineOf('_(It stopped: The user declined this tool call)_'), '(It stopped: The user declined this tool call)');
  assert.equal(lineOf('**Fixed** *it* in `a.js`: [the PR](https://x.test) for T214_WLK-10224'), 'Fixed it in a.js: the PR for T214_WLK-10224');
  assert.equal(lineOf([{ kind: 'screen', text: 'a screen' }, { kind: 'text', markdown: '\n\n- first item' }]), 'first item');
  assert.equal(lineOf([{ kind: 'plain', text: 'Allow *this*?' }]), 'Allow *this*?', 'plain text is as it is');
});

test('what this bot sent, tagged by hc with its process id on the way to another machine, is yours: not posted again, and never "From"', async () => {
  const t = terminal('t1', { program: 'fake', agent: true });
  const { chat, hc, store, engine, r, done } = await setup([t]);
  const room = rooms(store)['s|t1'].chat;
  assert.ok(store.read().botPids.includes(process.pid), 'its process id is kept');
  await engine.onMessage({ room, where: room, message: 'm-1', text: 'fix it', images: [] });
  r.queue('t1', [
    { role: 'you', text: `<hc from="m1/ppid:${process.pid}">fix it</hc>`, at: '2026-01-02T00:00:01.000Z', id: 'a' },
    { role: 'you', text: '<hc from="m1/ppid:4242">sent before a restart</hc>', at: '2026-01-02T00:00:02.000Z', id: 'b' },
    { role: 'you', text: '<hc from="m1/ppid:7">a script\'s</hc>', at: '2026-01-02T00:00:03.000Z', id: 'c' },
    { role: 'ai', text: 'Done.', at: '2026-01-02T00:00:04.000Z', id: 'd', end: true },
  ]);
  const state = store.read();
  state.botPids = [4242, ...state.botPids];
  store.write(state);
  hc.turn('s', 't1', 'done');
  await settle(engine);
  const shown = chat.calls.filter((c) => ['post', 'postCard', 'editCard'].includes(c.name)).map((c) => JSON.stringify(c.args)).join('\n');
  assert.ok(!/fix it/.test(shown), 'what you sent from the room is not posted again');
  assert.match(shown, /"kind":"you","text":"sent before a restart"/, 'yours, by an id it ran as before');
  assert.ok(!/ppid:4242/.test(shown));
  assert.match(shown, /"kind":"you","text":"a script's","from":"m1\/ppid:7"/, 'another program\'s stays from it');
  done();
});

test('Telegram: herdr\'s own topic is the direct chat, a command from outside any topic is answered there, and an overview from before it is not edited in place', async () => {
  const telegram = await import('../lib/chats/telegram/index.mjs');
  const store = fakeStore();
  const state = store.read();
  state.chats = { 'a|t1': { chat: '11', name: 'work / master' } };
  state.overview = { message: '5288' }; // from before the topic, in the main thread
  state.homeTopic = '900';
  store.write(state);
  const cfg = { env: { TELEGRAM_BOT_TOKEN: '1:test', TELEGRAM_OWNER_ID: '42' }, sessions: ['a'], muted: { all: true, spaces: [] }, silent: { all: false, spaces: [] } };
  const sent = [];
  const realFetch = globalThis.fetch;
  let stopped = false;
  let updates = [
    { update_id: 1, message: { message_id: 50, from: { id: 42 }, chat: { id: 42, type: 'private' }, is_topic_message: true, message_thread_id: 900, text: '/ls' } },
    { update_id: 2, message: { message_id: 51, from: { id: 42 }, chat: { id: 42, type: 'private' }, is_topic_message: true, message_thread_id: 11, text: 'hi' } },
  ];
  globalThis.fetch = async (url, opts) => {
    const method = url.split('/').pop();
    const body = JSON.parse(opts.body);
    sent.push({ method, body });
    if (method === 'getMe') return { ok: true, json: async () => ({ ok: true, result: { username: 'bot', has_topics_enabled: true } }) };
    if (method === 'getUpdates') {
      // once the test is done, the poll waits for ever: nothing keeps the process up
      if (stopped) return new Promise(() => {});
      const u = updates;
      updates = [];
      if (!u.length) await new Promise((r) => setTimeout(r, 50));
      return { ok: true, json: async () => ({ ok: true, result: u }) };
    }
    return { ok: true, json: async () => ({ ok: true, result: method === 'createForumTopic' ? { message_thread_id: 900 } : { message_id: sent.length } }) };
  };
  try {
    const chat = telegram.create({ cfg, store, log: quiet, logWarn: quiet, logError: quiet, stateDir: os.tmpdir(), lane: () => {}, scopeOf: () => 'a' });
    const got = [];
    chat.start({ onMessage: async (m) => { got.push(m); }, onAction: async () => ({}) });
    for (let i = 0; i < 100 && got.length < 2; i += 1) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(got.map((m) => [m.room, m.text]), [[null, '/ls'], ['11', 'hi']], 'its own topic is the direct chat; a room\'s topic is that room');
    await chat.reply('42:', 'answer');
    assert.equal(sent.filter((x) => x.method === 'sendMessage').at(-1).body.message_thread_id, 900, 'a command sent outside any topic is answered in herdr\'s topic');
    const shown = await chat.showOverview([{ name: 'work / master', address: 't1', state: 'idle', room: '11' }], {});
    assert.deepEqual(shown.old, '5288', 'the old one, outside the topic, is left for its record');
    assert.equal(sent.filter((x) => x.method === 'editMessageText').length, 0);
    assert.equal(sent.filter((x) => x.method === 'sendMessage').at(-1).body.message_thread_id, 900);
  } finally {
    stopped = true;
    await new Promise((r) => setTimeout(r, 120)); // the poll in flight comes back once more
    globalThis.fetch = realFetch;
  }
});

test('Telegram: the new-terminal form a field at a time: buttons for a pick, your next words in its topic for a text, a field that does not apply skipped; a mistake starts it again', async () => {
  const telegram = await import('../lib/chats/telegram/index.mjs');
  const store = fakeStore();
  const state = store.read();
  state.homeTopic = '900';
  store.write(state);
  const cfg = { env: { TELEGRAM_BOT_TOKEN: '1:test', TELEGRAM_OWNER_ID: '42' }, sessions: ['a'], muted: { all: true, spaces: [] }, silent: { all: false, spaces: [] } };
  const sent = [];
  const realFetch = globalThis.fetch;
  let stopped = false;
  let updates = [];
  globalThis.fetch = async (url, opts) => {
    const method = url.split('/').pop();
    const body = JSON.parse(opts.body);
    sent.push({ method, body });
    if (method === 'getMe') return { ok: true, json: async () => ({ ok: true, result: { username: 'bot', has_topics_enabled: true } }) };
    if (method === 'getUpdates') {
      if (stopped) return new Promise(() => {});
      const u = updates;
      updates = [];
      if (!u.length) await new Promise((r) => setTimeout(r, 20));
      return { ok: true, json: async () => ({ ok: true, result: u }) };
    }
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 70 } }) };
  };
  const form = {
    id: 'f1',
    title: 'New',
    markdown: 'Where.',
    submit: 'Start',
    fields: [
      { name: 'space', label: 'Space', kind: 'pick', options: [{ label: 'proj', value: 's0' }, { label: '＋ New space', value: 'n0' }] },
      { name: 'name', label: 'Name', kind: 'text', optional: true, when: { field: 'space', values: ['n0'] } },
      { name: 'agent', label: 'Agent', kind: 'pick', options: [{ label: 'Claude Code', value: 'claude' }] },
      { name: 'tab', label: 'Tab', kind: 'text', optional: true },
    ],
  };
  // each update is sent once the one before it is fully handled: a tap is answered last
  // (answerCallbackQuery), a text for the form edits it, one that is not reaches onMessage
  // (got, below); the bot's own queue spaces its calls, so this waits on the event, not a time
  let n = 0;
  const count = (method) => sent.filter((x) => x.method === method).length;
  const until = async (done) => { for (let i = 0; i < 1000 && !done(); i += 1) await new Promise((r) => setTimeout(r, 10)); assert.ok(done(), 'the bot answered'); };
  const tap = async (data) => { const before = count('answerCallbackQuery'); updates.push({ update_id: (n += 1), callback_query: { id: `q${n}`, from: { id: 42 }, data, message: { message_id: 70 } } }); await until(() => count('answerCallbackQuery') > before); };
  const say = async (text, { form = true } = {}) => {
    const [edits, messages] = [count('editMessageText'), got.length];
    updates.push({ update_id: (n += 1), message: { message_id: 100 + n, from: { id: 42 }, chat: { id: 42, type: 'private' }, is_topic_message: true, message_thread_id: 900, text } });
    await until(() => (form ? count('editMessageText') > edits : got.length > messages));
  };
  const got = [];
  const lastEdit = () => sent.filter((x) => x.method === 'editMessageText').at(-1).body;
  const datas = (body) => body.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
  try {
    const chat = telegram.create({ cfg, store, log: quiet, logWarn: quiet, logError: quiet, stateDir: os.tmpdir(), lane: () => {}, scopeOf: () => 'a' });
    const back = [];
    let answer = { toast: { type: 'error', text: 'A new space needs a name.' } };
    chat.start({ onMessage: async (m) => { got.push(m); }, onAction: async (a) => { back.push(a); return answer; } });
    await chat.showForm(null, form);
    const first = sent.filter((x) => x.method === 'sendMessage').at(-1).body;
    assert.equal(first.message_thread_id, 900, 'in herdr\'s topic');
    assert.deepEqual(datas(first), ['#f1:0', '#f1:1']);
    // a space there is: its name is not asked
    await tap('#f1:0');
    assert.match(lastEdit().text, /Space: <b>proj<\/b>[\s\S]*Agent\?/);
    await tap('#f1:0');
    assert.match(lastEdit().text, /Send the tab/);
    assert.deepEqual(datas(lastEdit()), ['#f1:skip']);
    await say('logs');
    assert.deepEqual(back.at(-1).form, { space: 's0', agent: 'claude', tab: 'logs' });
    assert.equal(got.length, 0, 'the text was the form\'s, not a message to the bot');
    assert.match(lastEdit().text, /⚠️ A new space needs a name\.[\s\S]*Space\?/, 'a mistake: from the start, saying what');
    // a new space: its name is asked; Skip leaves a text empty
    await tap('#f1:1');
    assert.match(lastEdit().text, /Send the name/);
    await say('api');
    await tap('#f1:0');
    answer = { toast: { type: 'info', text: 'Starting…' }, card: { kind: 'look', look: { title: 'Starting…', tone: 'working', markdown: 'api / claude' } } };
    await tap('#f1:skip');
    assert.deepEqual(back.at(-1).form, { space: 'n0', name: 'api', agent: 'claude', tab: '' });
    assert.match(lastEdit().text, /Starting…[\s\S]*api \/ claude/);
    assert.deepEqual(lastEdit().reply_markup.inline_keyboard, []);
    await tap('#f1:0');
    assert.equal(sent.filter((x) => x.method === 'answerCallbackQuery').at(-1).body.text, 'This form is old (the bot restarted, or it was used). Send /new for a new one.');
    await say('hello', { form: false });
    assert.deepEqual(got.map((m) => m.text), ['hello'], 'once it is done, your words are yours again');
  } finally {
    stopped = true;
    await new Promise((r) => setTimeout(r, 120));
    globalThis.fetch = realFetch;
  }
});

test('a "done" kept waiting from before is let go at start, with nothing rung', async () => {
  const t1 = terminal('t1', { program: 'fake', agent: true });
  const first = await setup([t1]);
  first.done();
  const state = first.store.read();
  state.notes = { 's|t1': { kind: 'done', name: state.chats['s|t1'].name, line: 'seen long ago', at: 1, out: true } };
  first.store.write(state);
  const chat = fakeChat();
  const hc = fakeHc();
  const r = fakeReaders();
  const engine = createEngine({ cfg: { sessions: ['s'], doneWaitMs: 0 }, chat, hc, readers: r.readers, store: first.store, log: quiet, logWarn: quiet, logError: quiet, startedAt: '2026-01-01T00:00:00.000Z', inbox: os.tmpdir(), quick: true });
  running.add(engine);
  const started = engine.start();
  hc.snapshot('s', [t1]);
  await started;
  await pause(60);
  await settle(engine);
  assert.equal(first.store.read().notes?.['s|t1'], undefined);
  assert.deepEqual(marked(chat), []);
  assert.equal(rang(chat).length, 0);
  engine.stop();
});

test('a secret an agent says is hidden in its room, in the overview\'s latest and in what rang; the log says only what kind was hidden', async () => {
  const t = terminal('t1', { program: 'fake', agent: true });
  const logs = [];
  const chat = fakeChat();
  const hc = fakeHc();
  const store = fakeStore();
  const r = fakeReaders();
  const engine = createEngine({ cfg: { sessions: ['s'], doneWaitMs: 0, env: {} }, chat, hc, readers: r.readers, store, log: (...a) => logs.push(a.join(' ')), logWarn: quiet, logError: quiet, startedAt: '2026-01-01T00:00:00.000Z', inbox: os.tmpdir(), quick: true });
  running.add(engine);
  const started = engine.start();
  hc.snapshot('s', [t]);
  await started;
  await settle(engine);
  const token = 'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
  answer(r, hc, `Use ${token} to push.`, 1);
  await pause(60);
  await settle(engine);
  const sent = JSON.stringify(chat.calls.filter((c) => c.name !== 'start').map((c) => c.args));
  assert.ok(!sent.includes(token), 'nothing the chat app got holds it');
  assert.match(said(chat.of('post').at(-1).args[1]), /Use \[hidden: GitHub token\] to push\./);
  const row = chat.of('showOverview').at(-1).args[0].find((x) => x.address === 't1');
  assert.equal(row.latest, 'Use [hidden: GitHub token] to push.');
  assert.ok(logs.some((l) => /hidden in post: GitHub token ×1/.test(l)));
  assert.ok(!logs.join('\n').includes(token), 'nor the log');
  engine.stop();
});
