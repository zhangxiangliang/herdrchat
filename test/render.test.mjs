// What the chat apps are sent, held still: the Feishu cards, the Telegram messages and
// what the core hands the chat side, for one fixed set of inputs. A change in how anything
// looks shows here as a diff against test/snapshots/render.json; when the change is meant,
// write the file again: UPDATE_SNAPSHOTS=1 node --test test/render.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createEngine } from '../lib/core/engine.mjs';
import { sendMarkdown } from '../lib/chats/feishu/client.mjs';
import { doneCard, foldedCard, header, menuCard, ownerCard, textCard } from '../lib/chats/feishu/render.mjs';
import { overviewCard, overviewText } from '../lib/chats/feishu/overview.mjs';
import { fakeChat, fakeHc, fakeReaders, fakeStore, terminal } from './fakes.mjs';

process.env.TZ = 'UTC'; // the overview's clock
const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'snapshots', 'render.json');
const update = process.env.UPDATE_SNAPSHOTS === '1';
const saved = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : {};
const seen = {};
after(() => {
  if (!update) return;
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, `${JSON.stringify({ ...saved, ...seen }, null, 2)}\n`);
});
function same(name, value) {
  const plain = JSON.parse(JSON.stringify(value));
  seen[name] = plain;
  if (update) return;
  assert.ok(name in saved, `no snapshot "${name}" yet: UPDATE_SNAPSHOTS=1 node --test test/render.test.mjs`);
  assert.deepEqual(plain, saved[name]);
}

const quiet = () => {};
const MENU = { options: [{ n: 1, label: 'Yes', checked: null }, { n: 2, label: 'Yes, and don\'t ask again for this', checked: null }, { n: 3, label: 'No', checked: null }], multi: false, free: null };
const MULTI = { options: [{ n: 1, label: 'Red', checked: true }, { n: 2, label: 'Green', checked: false }, { n: 3, label: 'Type something', checked: null }], multi: true, free: null };
MULTI.free = MULTI.options[2];
const ROWS = [
  { name: 'alpha / docs', address: 't1', state: 'done', room: 'oc_a', since: Date.UTC(2026, 0, 1, 9, 30) },
  { name: 'beta / T1_ABC-2', address: 'box/t2', state: 'blocked', kind: 'permission', room: 'oc_b' },
  { name: 'alpha / shell', address: 't4', program: 'zsh' },
];

test('Feishu: every kind of card', async () => {
  same('feishu.header', ['working', 'closed', 'needs', 'done', 'good', 'bad'].map((tone) => header('✅ A title', tone)));
  same('feishu.textCard', textCard('**You:**\n> fix it\n\n▸ bash: ls', '⌛️ Working…', 'working', 'claude · m · main'));
  same('feishu.menuCard', menuCard({ title: '⚠️ Needs you (permission)', markdown: 'Run ls?', menu: MENU, value: { s: 's', a: 't1', k: 'k1' }, footer: 'codex · screen' }));
  same('feishu.menuCard.multi', menuCard({ title: '⚠️ Needs you (question)', markdown: 'Which colors?', menu: MULTI, value: { s: 's', a: 't1', k: 'k2' } }));
  same('feishu.doneCard', doneCard('✅ Done', 'Run ls?', '✔ Yes', 'claude · m'));
  same('feishu.ownerCard', ownerCard({ title: '⬆️ herdrchat 9.9.9 is out', tone: 'working', markdown: 'You run 1.0.0.', buttons: [{ label: 'Update to 9.9.9', value: { update: '9.9.9' } }] }));
  same('feishu.foldedCard', foldedCard('📜 Before this room', '**You:**\n> hi\n\nHello.'));
  same('feishu.overview', { text: overviewText(ROWS), card: overviewCard(ROWS, Date.UTC(2026, 0, 1, 10, 0)) });
  const sent = [];
  const client = { im: { v1: { message: { create: async (req) => { sent.push(req); return { data: { message_id: `m${sent.length}` } }; } } } } };
  await sendMarkdown(client, 'oc_room', `${'line one\n'.repeat(800)}last`, 'pi · glm');
  await sendMarkdown(client, 'open_id:ou_x', 'a reply');
  same('feishu.sendMarkdown', sent);
});

test('Telegram: every kind of message', async () => {
  const telegram = await import('../lib/chats/telegram/index.mjs');
  const store = fakeStore();
  const state = store.read();
  state.chats = { 'a|t1': { chat: '11', name: 'work / master' }, 'a|t2': { chat: '12', name: 'play / x' } };
  store.write(state);
  const cfg = { env: { TELEGRAM_BOT_TOKEN: '1:test', TELEGRAM_OWNER_ID: '42' }, sessions: ['a'], muted: { all: false, spaces: ['work'] }, silent: { all: false, spaces: [] } };
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    sent.push({ method: url.split('/').pop(), body: JSON.parse(opts.body) });
    return { ok: true, json: async () => ({ ok: true, result: { message_id: sent.length, message_thread_id: 77 } }) };
  };
  try {
    const chat = telegram.create({ cfg, store, log: quiet, logWarn: quiet, logError: quiet, stateDir: os.tmpdir(), lane: () => {}, scopeOf: () => 'a' });
    await chat.post('11', '**You:**\n> fix `it` <now>\n\nDone & *dusted*.', { footer: 'claude · m · main' });
    await chat.postCard('12', { title: '⌛️ Working…', tone: 'working', markdown: '▸ bash: ls\n▸ read: a.txt', footer: 'codex · m' });
    await chat.editCard('2', { title: '✅ Worked', tone: 'closed', markdown: '▸ bash: ls', footer: 'codex · m' });
    await chat.postDialog('11', { title: '⚠️ Needs you (permission)', markdown: 'Run ls?', menu: MENU, footer: 'claude · screen' }, { s: 'a', a: 't1', k: 'k1' });
    await chat.postDialog('11', { title: '⚠️ Needs you (question)', markdown: 'Which colors?', menu: MULTI }, { s: 'a', a: 't1', k: 'k2' });
    await chat.closeDialog('4', { doneTitle: '✅ Done', markdown: 'Run ls?', footer: 'claude · m' }, '✔ Yes');
    await chat.ring('a|t1', '1', '✅ done');
    await chat.reply('11', 'It asks something first.');
    await chat.postFolded('11', { title: '📜 Before this room', markdown: '**You:**\n> hi\n\nHello.' });
    await chat.tellOwner({ title: '⬆️ herdrchat 9.9.9 is out', tone: 'working', markdown: 'You run 1.0.0.', buttons: [{ label: 'Update to 9.9.9', value: { update: '9.9.9' } }] });
    await chat.showOverview(ROWS.map((r) => ({ ...r, room: r.room ? '11' : null })));
  } finally {
    globalThis.fetch = realFetch;
  }
  // a dialog's buttons carry a random id: the same everywhere, so held as "<id>"
  const ids = new Map();
  const steady = JSON.parse(JSON.stringify(sent), (k, v) => (k === 'callback_data' && typeof v === 'string' ? v.replace(/^[^:]+/, (id) => { if (!ids.has(id)) ids.set(id, `<id${ids.size}>`); return ids.get(id); }) : v));
  same('telegram.sent', steady);
});

// The core's side: what one terminal's turns, dialogs and end hand the chat app.
const running = new Set();
after(() => running.forEach((engine) => engine.stop()));
async function settle(engine) {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((ok) => setTimeout(ok, 15));
    await engine.tick.idle();
  }
}

test('the core: what it hands the chat app for a turn, a dialog, a screen and an end', async () => {
  const chat = fakeChat();
  const hc = fakeHc();
  const store = fakeStore();
  const r = fakeReaders();
  const inbox = fs.mkdtempSync(path.join(os.tmpdir(), 'herdrchat-render-test-'));
  const t = terminal('t1', { program: 'fake', agent: true });
  t.foreground.cwd = '/w';
  const engine = createEngine({ cfg: { sessions: ['s'] }, chat, hc, readers: r.readers, store, log: quiet, logWarn: quiet, logError: (...a) => { throw new Error(a.join(' ')); }, startedAt: '2026-01-01T00:00:00.000Z', inbox, quick: true, asksWaiting: () => false, askLives: async () => true, shell: async () => 'main\n' });
  running.add(engine);
  const started = engine.start();
  hc.snapshot('s', [t]);
  await started;
  await settle(engine);
  const room = store.read().chats['s|t1'].chat;
  // a turn: your message, tools, an image, a note from another terminal, the answer
  await engine.onMessage({ room, where: room, message: 'm-in', text: 'fix it', images: [] });
  r.queue('t1', [
    { role: 'meta', model: 'model-a', at: '2026-01-02T00:00:00.000Z', id: 'm' },
    { role: 'you', text: 'fix it', at: '2026-01-02T00:00:01.000Z', id: 'a' },
    { role: 'you', text: 'typed in the terminal too', at: '2026-01-02T00:00:02.000Z', id: 'b' },
    { role: 'tool', text: '▸ bash: ls', at: '2026-01-02T00:00:03.000Z', id: 'c', context: { used: 50000, size: 200000 } },
    { role: 'tool', text: '▸ read: a.txt', at: '2026-01-02T00:00:04.000Z', id: 'd' },
    { role: 'image', from: 'ai', media: 'image/png', data: 'AAAA', at: '2026-01-02T00:00:05.000Z', id: 'e' },
    { role: 'you', text: '<hc from="t7 review" reach="t1">look at this</hc>', at: '2026-01-02T00:00:06.000Z', id: 'f' },
    { role: 'ai', text: 'Fixed it.', at: '2026-01-02T00:00:07.000Z', id: 'g', end: true },
  ]);
  hc.turn('s', 't1', 'done');
  await settle(engine);
  // a dialog read off the screen, then one with no menu
  hc.screens.set('s|t1', '╭──────╮\n│ Allow ls?\n│ ❯ 1. Yes\n│   2. No\n╰──────╯');
  t.status = { app: 'fake-agent', state: 'blocked', kind: 'permission' };
  hc.change('s', 'status', t);
  hc.turn('s', 't1', 'blocked');
  await settle(engine);
  hc.screens.set('s|t1', 'Press any key to go on');
  t.status = { app: 'fake-agent', state: 'working' };
  hc.change('s', 'status', t);
  await settle(engine);
  // the end
  hc.change('s', 'finished', { ...t, state: 'finished', foreground: null }, { reason: 'exit 0' });
  await settle(engine);
  engine.stop();
  fs.rmSync(inbox, { recursive: true, force: true });
  const calls = chat.calls.filter((c) => !['start', 'showOverview', 'markWorking', 'markDone'].includes(c.name)).map((c) => [c.name, ...c.args]);
  same('core.calls', calls);
});
