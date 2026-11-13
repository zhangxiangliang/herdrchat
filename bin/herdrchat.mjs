#!/usr/bin/env node
// herdr-app, moved to Feishu. One bot for every hc session in HERDR_SESSIONS (config.env):
//   every tab herdr-app shows (a `where` label; `herdr.tab` is its id) -> one group,
//     named "<space> / <tab>", tagged with its session; what you type there goes to its terminal
//   the direct chat with the bot -> herdr itself: /ls, /new, /kill
// hc is the backbone: its events say which terminals exist, their status and when a
// turn ends (a program left `working`). What the program said comes from its reader
// (lib/readers/: the agent's own records, so your prompts and its answers, posted live
// while it works); anything but a running agent posts nothing by itself.
// Only what happens after the bot starts is posted, never older history.
//
// Usage: node bin/herdrchat.mjs
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { COLORS, avatarPng, letterOf } from '../lib/avatar.mjs';
import { overviewCard, overviewText } from '../lib/overview.mjs';
import { CONFIG_FILE, STATE_DIR, loadConfig, makeDirs, readState, writeState } from '../lib/config.mjs';
import { advance, startCursor } from '../lib/cursor.mjs';
import { followEvents } from '../lib/events.mjs';
import { bindTag, chunk, createChat, createClient, createTag, recallMessage, replyMention, setChatAvatar, tagName, unbindTag, doneCard, downloadImage, menuCard, messageParts, renameChat, sendCard, sendMarkdown, startEvents, textCard, updateCard, uploadImage } from '../lib/feishu.mjs';
import { cores, getTerminal, hc, keys, machineOf, machines, put, run, screenTail, send, plainError, splitWhere, tidyScreen } from '../lib/hc.mjs';
import { menuOf } from '../lib/menu.mjs';
import { createLog } from '../lib/log.mjs';
import { agentOf, readerFor } from '../lib/readers/index.mjs';
import { createUserAuth } from '../lib/userauth.mjs';
import { coreViews } from '../lib/views.mjs';

const SHELL_ECHO_MS = 1500;
const SCREEN_LINES = 40;
const TURN_SCREEN_LINES = 150;
const POST_TRIES = 5;
const SWEEP_MS = 60 * 1000;
const SWEEP_DONE_MS = 30 * 1000;
const LIVE_MS = 5000;
const END_TRIES = 20;
const END_WAIT_MS = 750;
const KEY_SETTLE_MS = 700; // a dialog redraws this soon after a key
const CLICK_BUDGET_MS = 2000; // a card click must be answered within 3 s
const STARTED = new Date().toISOString();

makeDirs();
const cfg = loadConfig();
const client = createClient(cfg);
const userAuth = createUserAuth(cfg, STATE_DIR);
const logger = createLog(path.join(STATE_DIR, 'logs'));
logger.capture({ onCrash: sayCrash });
const log = logger.info;
const logWarn = logger.warn;
const logError = logger.error;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A bot that is down is a phone that hears nothing, so down time is said in the direct
// chat: a crash says why (at most once per CRASH_NOTICE_MS, as a restart loop repeats
// it), and the next connection says how long it was gone.
const CRASH_NOTICE_MS = 10 * 60 * 1000;
async function sayCrash(err) {
  if (!cfg.ownerOpenId) return;
  const now = Date.now();
  const state = readState();
  const down = { since: now, said: 0, ...state.down, why: String(err?.message || err).slice(0, 300) };
  const say = now - down.said >= CRASH_NOTICE_MS;
  if (say) down.said = now;
  state.down = down;
  writeState(state);
  if (!say) return;
  const text = `herdrchat stopped: ${down.why}\n\nIt is being started again. Until it is back, nothing you send here reaches your terminals.`;
  await sendCard(client, cfg.ownerOpenId, textCard(text, '🔴 herdrchat is down', 'red'), 'open_id');
}
async function sayBack() {
  const state = readState();
  const { down } = state;
  if (!down) return;
  delete state.down;
  writeState(state);
  if (!cfg.ownerOpenId) return;
  const minutes = Math.max(1, Math.round((Date.now() - down.since) / 60000));
  const text = `herdrchat is back after about ${minutes} min. What stopped it: ${down.why}`;
  await sendCard(client, cfg.ownerOpenId, textCard(text, '✅ herdrchat is back', 'green'), 'open_id');
}

const views = new Map(); // session -> followEvents handle (its live terminal records)

// One terminal can be seen through several sessions (lib/views.mjs): hc's core ids say
// which views are the same terminal, and only one of them is followed. They are read at
// start and again every SWEEP_MS, as machines come and go.
let topology = coreViews(cfg.sessions, new Map());
async function readCores() {
  const found = new Map();
  for (const session of cfg.sessions) {
    try {
      found.set(session, await cores(session));
    } catch (err) {
      logWarn(`cores of ${session}: ${err.message}`);
    }
  }
  topology = coreViews(cfg.sessions, found);
}
const coresRead = readCores();

// A terminal's key in state.json is "<session>|tN", or "@<machine>|<machine>/tN" for one
// on another machine, as named by the view that follows it.
function scopeOf(session, address) {
  return machineOf(address) || session;
}

const key = (session, address) => `${machineOf(address) ? '@' : ''}${scopeOf(session, address)}|${address}`;
const scopeOfKey = (k) => k.slice(k.startsWith('@') ? 1 : 0, k.indexOf('|'));
const addressOfKey = (k) => k.slice(k.indexOf('|') + 1);

function handles(session, address) {
  const owns = topology.owns(session, address);
  if (owns !== null) return owns;
  // cores unknown: a terminal here is ours, one on a machine is the first session's that sees it
  if (!machineOf(address)) return true;
  return cfg.sessions.find((s) => views.get(s)?.terminals.get(address)?.state === 'live') === session;
}

// Work for one terminal runs one at a time, in order (its lane): no races on its group
// or its cursor. Terminals do not wait for each other, so a busy one cannot hold back
// another's dialog card. Nothing runs before every session's first snapshot is in, so a
// terminal on another machine is claimed by the same session every time.
const firstSnapshot = new Map(cfg.sessions.map((s) => {
  let done;
  const promise = new Promise((r) => { done = r; });
  return [s, { promise, done }];
}));
const ready = Promise.all([coresRead, ...[...firstSnapshot.values()].map((x) => x.promise)]);
const lanes = new Map(); // terminal key -> its last queued work
function later(session, address, label, fn) {
  const k = key(session, address);
  const next = (lanes.get(k) || ready).then(fn).catch((err) => logError(`${label} ${address}:`, err));
  lanes.set(k, next);
  next.then(() => { if (lanes.get(k) === next) lanes.delete(k); });
  return next;
}

// ---------- terminals and their groups ----------

function shownWhere(record) {
  return record && record.state === 'live' ? splitWhere(record.labels?.where) : null;
}

// A group is named after where herdr-app shows the terminal; the session (or, for a
// terminal on another machine, the machine) is the group's tag. A tab herdr-app only
// numbered ("2") says nothing, so the terminal's title stands in for it (what any
// program sets with the standard title sequence; Claude Code sets its session name or
// topic), then its hc name; leading status glyphs are dropped, so a spinner in a title
// never renames a group.
const TITLE_MAX = 40;

function tabName(where, record) {
  if (!/^\d+$/.test(where.tab)) return where.tab;
  const title = String(record.title || '').replace(/^[^\p{L}\p{N}]+/u, '').replace(/\s+/g, ' ').trim();
  const name = title || record.name || '';
  if (!name) return where.tab;
  return name.length > TITLE_MAX ? `${name.slice(0, TITLE_MAX - 1)}…` : name;
}

function groupName(where, record) {
  return `${where.space} / ${tabName(where, record)}`;
}

// Lanes run side by side: a thing that is made once (a tag, a space's avatar) is made
// by the first lane that needs it; the others wait for that.
const making = new Map();
function once(id, make) {
  if (!making.has(id)) making.set(id, make().finally(() => making.delete(id)));
  return making.get(id);
}

// One tenant tag per session or machine, made once, and one "ended" tag; their ids are
// kept in state.json (tags).
const ENDED_TAG = '#ended';

async function tagOf(id, name = id) {
  return readState().tags?.[id] || once(`tag ${id}`, async () => {
    const tag = await createTag(client, name);
    const state = readState();
    state.tags = { ...(state.tags || {}), [id]: tag };
    writeState(state);
    log(`created tag ${name} (${tag})`);
    return tag;
  });
}

// Each space gets an avatar: its first letter on a color of its own (the first color no
// other space has), kept in state.json (spaces), so all of its groups look alike, as in
// herdr-app. An avatar is a nicety: a failure is logged and tried again at the next check.
// The color is picked and saved before the first await, so spaces made side by side
// never pick the same one.
function colorOf(space) {
  const state = readState();
  const spaces = state.spaces || {};
  if (spaces[space]?.color) return spaces[space].color;
  const used = Object.values(spaces).map((x) => x.color);
  const color = COLORS.find((c) => !used.includes(c)) || COLORS[used.length % COLORS.length];
  state.spaces = { ...spaces, [space]: { color } };
  writeState(state);
  return color;
}

async function avatarOf(space) {
  return readState().spaces?.[space]?.image || once(`avatar ${space}`, async () => {
    const color = colorOf(space);
    const image = await uploadImage(client, await avatarPng(letterOf(space), color), 'avatar');
    const state = readState();
    state.spaces = { ...(state.spaces || {}), [space]: { color, image } };
    writeState(state);
    log(`made avatar for space ${space} (${color})`);
    return image;
  });
}

async function avatarChat(k, chat, space) {
  try {
    const image = await avatarOf(space);
    if (readState().chats[k]?.avatar === image) return;
    await setChatAvatar(client, chat, image);
    const state = readState();
    if (state.chats[k]) state.chats[k] = { ...state.chats[k], avatar: image };
    writeState(state);
  } catch (err) {
    logError(`avatar ${space} on ${chat}: ${err.message}`);
  }
}

// Bot tags (HERDR_BOT_TAGS): the session or machine tag next to a group's name and, once
// its terminal is gone, "ended". They are tenant tags, so they can be turned off; off takes
// off the ones already on. A tag is a nicety: a failure is logged and tried again at the
// next check, and never holds back a post.
async function syncBotTags(k) {
  const c = readState().chats[k];
  if (!c) return;
  try {
    if (cfg.botTags) {
      const tag = await tagOf(scopeOfKey(k));
      if (c.tag !== tag) {
        await bindTag(client, tag, c.chat);
        setChat(k, { tag });
      }
      if (c.ended !== Boolean(c.endedTag)) {
        const ended = await tagOf(ENDED_TAG, 'ended');
        await (c.ended ? bindTag : unbindTag)(client, ended, c.chat);
        setChat(k, { endedTag: Boolean(c.ended) });
      }
    } else {
      const tags = readState().tags || {};
      if (c.tag) {
        await unbindTag(client, c.tag, c.chat).catch(() => {});
        setChat(k, { tag: null });
      }
      if (c.endedTag && tags[ENDED_TAG]) {
        await unbindTag(client, tags[ENDED_TAG], c.chat).catch(() => {});
        setChat(k, { endedTag: false });
      }
    }
  } catch (err) {
    logError(`bot tags on ${c.name}: ${err.message}`);
  }
}

// ---------- acting as you (optional, after /auth) ----------

// With your token (lib/userauth.mjs) the bot does what only you can: mutes its groups,
// puts each in one of your own labels (the session or machine; "ended" once the terminal
// is gone) besides its bot tag, pins the group that needs you, and @-mentions you in a
// one-line reply under a card that needs you and under the turn's last answer, since in a
// muted group only a mention rings. Bot tags stay either way: they show next to a
// group's name, your labels only in the sidebar. Without the token none of this happens
// and the bot works as before. Whether it may act as you is checked every YOU_CHECK_MS;
// when that turns on, every group is brought in line; when it turns off, you are told once.
const YOU_CHECK_MS = 60 * 1000;
const ENDED_LABEL = 'ended';
let you = false;
let youCheckedAt = 0;

function setChat(k, fields) {
  const state = readState();
  if (state.chats[k]) state.chats[k] = { ...state.chats[k], ...fields };
  writeState(state);
}

async function asYou() {
  if (Date.now() - youCheckedAt < YOU_CHECK_MS) return you;
  youCheckedAt = Date.now();
  const was = you;
  you = await userAuth.allowed();
  if (you && !was) {
    log('acting as you: on');
    setTimeout(() => alignAll(), 0);
  } else if (!you && was) {
    logWarn('acting as you: off');
    await sendCard(client, cfg.ownerOpenId, textCard('The bot can no longer act as you (mute, labels, pin). Send `/auth` to allow it again.', '⚠️ Needs you', 'red'), 'open_id').catch(() => {});
  }
  return you;
}

async function labelOf(name) {
  return readState().labels?.[name] || once(`label ${name}`, async () => {
    const found = (await userAuth.feedGroups())?.groups?.find((g) => g.name === name);
    const id = found?.group_id || (await userAuth.createFeedGroup(name))?.group_id;
    if (!id) throw new Error(`no label ${name}`);
    const state = readState();
    state.labels = { ...(state.labels || {}), [name]: id };
    writeState(state);
    log(`label ${name} (${id})`);
    return id;
  });
}

// A label you deleted is made again at the next try.
async function intoLabel(name, chat) {
  try {
    await userAuth.addToFeedGroup(await labelOf(name), [chat]);
  } catch (err) {
    const state = readState();
    if (state.labels) delete state.labels[name];
    writeState(state);
    throw err;
  }
}

// Your label (HERDR_USER_TAGS, acting as you): the session or machine, or "ended" once the
// terminal is gone; off takes the group out of it (the label itself stays: it is yours).
async function syncUserLabel(k) {
  if (!(await asYou())) return;
  const c = readState().chats[k];
  if (!c) return;
  const want = cfg.userTags ? (c.ended ? ENDED_LABEL : tagName(scopeOfKey(k))) : null;
  if ((c.label || null) === want) return;
  try {
    if (c.label) await userAuth.removeFromFeedGroup(await labelOf(c.label), [c.chat]).catch(() => {});
    if (want) await intoLabel(want, c.chat);
    setChat(k, { label: want });
  } catch (err) {
    logError(`as you, label of ${c.name}: ${err.message}`);
  }
}

// HERDR_MUTED_SPACES says which groups are muted (all, none, or some spaces); a change in
// config.env is applied both ways at the next start.
const inSpaces = (set, space) => set.all || set.spaces.includes(space);

async function muteChat(k, chat, space) {
  const want = inSpaces(cfg.muted, space);
  if (Boolean(readState().chats[k]?.muted) === want) return;
  await userAuth.setMuted([chat], want);
  setChat(k, { muted: want });
}

// Puts a live group where it belongs: its bot tag and, acting as you, muted and in your
// label. Cheap when nothing is left to do.
async function placeChat(k, chat, space) {
  await syncBotTags(k);
  if (!(await asYou())) return;
  await muteChat(k, chat, space).catch((err) => logError(`as you, mute ${chat}: ${err.message}`));
  await syncUserLabel(k);
}

// Everything at once, when acting as you turns on: live groups to their labels, ended
// ones to "ended", bot tags off.
function alignAll() {
  for (const [k, c] of Object.entries(readState().chats)) {
    if (!cfg.sessions.includes(c.session)) continue;
    later(c.session, addressOfKey(k), 'as you', () => (c.ended ? endChat(k, { again: true }) : placeChat(k, c.chat, c.name.split(' / ')[0])));
  }
}

// The group that needs you is pinned while it waits, and unpinned when it no longer does.
async function pinChat(k, chat) {
  if (!(await asYou())) return;
  try {
    await userAuth.pin(chat);
    const state = readState();
    state.pinned = { ...(state.pinned || {}), [k]: chat };
    writeState(state);
  } catch (err) {
    logError(`pin ${chat}: ${err.message}`);
  }
}

async function unpinChat(k) {
  const chat = readState().pinned?.[k];
  if (!chat) return;
  try {
    await userAuth.unpin(chat);
  } catch (err) {
    logError(`unpin ${chat}: ${err.message}`);
  }
  const state = readState();
  delete state.pinned[k];
  writeState(state);
}

// In a muted group only a mention rings; a group that is not muted rings anyway. A space
// in HERDR_SILENT_SPACES gets no mention at all.
async function mentionYou(k, messageId, text) {
  const c = readState().chats[k];
  if (!messageId || !c?.muted || inSpaces(cfg.silent, c.name.split(' / ')[0]) || !(await asYou())) return;
  await replyMention(client, messageId, cfg.ownerOpenId, text).catch((err) => logError(`mention: ${err.message}`));
}

function chatOf(session, address) {
  return readState().chats[key(session, address)];
}

function terminalOfChat(chatId) {
  for (const [k, v] of Object.entries(readState().chats)) {
    if (v.chat === chatId) return { session: v.session, address: addressOfKey(k) };
  }
  return null;
}

// A group belongs to a herdr-app tab, by the tab's id (`herdr.tab`), not to the terminal
// that happens to run in it: when the terminal is replaced (Claude quit and the tab got a
// new shell, a program was started again), the new one takes over the tab's group once
// the old one is gone. A tab that was deleted and made again has a new id, so a new group.
// Returns the group, null (none: make one), or WAIT (the old terminal still runs: its end
// hands the group over, see postEnd). The old terminal's last words are posted first.
const WAIT = Symbol('wait');
async function adoptTabChat(k, tab) {
  const before = Object.entries(readState().chats).find(([ok, c]) => ok !== k && c.tab === tab && scopeOfKey(ok) === scopeOfKey(k));
  if (!before) return null;
  const [ok, was] = before;
  if (views.get(was.session)?.terminals.get(addressOfKey(ok))?.state === 'live') return WAIT;
  await lanes.get(ok)?.catch(() => {}); // its end (postEnd) runs to the last item
  const state = readState();
  const old = state.chats[ok];
  if (!old) return null;
  delete state.chats[ok];
  state.chats[k] = old;
  for (const map of [state.pinned, state.reacts]) {
    if (map?.[ok]) {
      map[k] = map[ok];
      delete map[ok];
    }
  }
  if (state.cursors) delete state.cursors[ok];
  writeState(state);
  log(`group ${old.name} (${old.chat}) now follows ${addressOfKey(k)}, the new terminal of its tab`);
  await sendMarkdown(client, old.chat, `↪ This tab runs a new terminal now (${addressOfKey(k)}); it carries on here.`).catch((err) => logError(`adopt notice: ${err.message}`));
  return old;
}

async function ensureChat(session, record) {
  const where = shownWhere(record);
  if (!where || !cfg.ownerOpenId || !handles(session, record.address)) return null;
  const k = key(session, record.address);
  const name = groupName(where, record);
  const tab = record.labels?.['herdr.tab'] || null;
  // state.json is read again after each await: other terminals' lanes write it meanwhile
  const known = readState().chats[k] || (tab ? await adoptTabChat(k, tab) : null);
  if (known === WAIT) return null;
  if (known) {
    if (known.ended) await reviveChat(k, known);
    if (known.name !== name || known.session !== session || (tab && known.tab !== tab)) {
      if (known.name !== name) await renameChat(client, known.chat, name);
      const state = readState();
      state.chats[k] = { ...state.chats[k], name, session, ...(tab ? { tab } : {}) };
      writeState(state);
      if (known.name !== name) log(`renamed group ${known.chat} -> ${name}`);
    }
    await placeChat(k, known.chat, where.space);
    if (!known.avatar) await avatarChat(k, known.chat, where.space);
    return known.chat;
  }
  const chat = await createChat(client, cfg.ownerOpenId, name, `hc terminal ${record.address} (hc session "${session}"). Type here to talk to it.`);
  const state = readState();
  state.chats[k] = { chat, name, session, ...(tab ? { tab } : {}) };
  writeState(state);
  log(`created group ${name} (${chat})`);
  await placeChat(k, chat, where.space);
  await avatarChat(k, chat, where.space);
  return chat;
}

// A terminal that is gone keeps its group, with its history, tagged "ended", so a new
// terminal in the same place gets a group that is not mistaken for the old one. The tag
// goes when the terminal comes back.
async function endChat(k, { again = false } = {}) {
  const known = readState().chats[k];
  if (!known || (known.ended && !again)) return;
  setChat(k, { ended: true });
  if (!again) log(`ended group ${known.name} (${known.chat})`);
  await syncBotTags(k);
  if (!known.avatar) await avatarChat(k, known.chat, known.name.split(' / ')[0]);
  if (!(await asYou())) return;
  await muteChat(k, known.chat, known.name.split(' / ')[0]).catch((err) => logError(`as you, mute ${known.chat}: ${err.message}`));
  await syncUserLabel(k);
}

async function reviveChat(k, known) {
  setChat(k, { ended: false });
  await syncBotTags(k);
  await syncUserLabel(k);
  log(`group ${known.name} (${known.chat}) is live again`);
}

// Groups of terminals that ended while the bot was down get no end event: once every
// session's first snapshot is in, a group whose terminal is live in no session is ended.
// A terminal on another machine counts as gone only while that machine is connected,
// so a dropped connection never ends a group.
async function endGone() {
  const connected = new Set();
  for (const session of cfg.sessions) {
    for (const m of await machines(session).catch(() => [])) if (m.state === 'connected') connected.add(m.name);
  }
  // every live terminal, by what it is (lib/views.mjs) and by address when that is unknown
  const alive = new Set();
  for (const session of cfg.sessions) {
    for (const record of views.get(session)?.terminals.values() || []) {
      if (record.state === 'live') alive.add(topology.identity(session, record.address) || record.address);
    }
  }
  for (const [k, c] of Object.entries(readState().chats)) {
    const address = addressOfKey(k);
    const machine = machineOf(address);
    if (c.ended && !c.avatar) later(c.session, address, 'avatar', () => avatarChat(k, c.chat, c.name.split(' / ')[0]));
    if (c.ended || !cfg.sessions.includes(c.session) || (machine && !connected.has(machine))) continue;
    if (alive.has(topology.identity(c.session, address) || address)) continue;
    later(c.session, address, 'end', () => endChat(k));
  }
}

// A post is retried; when it still fails, the caller keeps its cursor, so the same
// content goes out with the next post: a repeat is acceptable, a loss is not.
function postTo(session, record, text) {
  return deliver(session, record, (chat) => sendMarkdown(client, chat, text));
}

async function deliver(session, record, send) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const chat = await ensureChat(session, record);
      return chat ? await send(chat) : null;
    } catch (err) {
      if (attempt >= POST_TRIES) throw err;
      logWarn(`post to ${session}/${record.address} failed (${err.message}); retry ${attempt}/${POST_TRIES - 1}`);
      await sleep(1000 * 2 ** attempt);
    }
  }
}

async function screen(session, address, lines = SCREEN_LINES) {
  return `\`\`\`\n${tidyScreen(await screenTail(session, address, lines)) || '(blank)'}\n\`\`\``;
}

// Per terminal, in state.json: the cursor of what its reader posted, which reader and
// which log that was (kept after the program exits, to post what it left).
function cursorOf(k) {
  return readState().cursors?.[k] || { ...startCursor(STARTED), reader: null, file: null };
}

function saveCursor(k, cursor) {
  const state = readState();
  state.cursors = { ...(state.cursors || {}), [k]: cursor };
  writeState(state);
}

// What you sent from Feishu; its group shows it already, so it is not posted again.
const fromFeishu = new Map();

function formatItems(k, items) {
  const sent = fromFeishu.get(k) || [];
  const parts = [];
  for (const it of items) {
    if (it.role === 'tool') {
      const last = parts[parts.length - 1];
      if (last?.startsWith('▸ ')) parts[parts.length - 1] = `${last}\n${it.text}`;
      else parts.push(it.text);
      continue;
    }
    if (it.role === 'image') {
      // uploaded by uploadImages. One you send from the group reaches the terminal as a
      // file path, so it comes back as your text, not as an image.
      const shown = it.key ? `![image](${it.key})` : `_(an image ${it.from === 'you' ? 'you pasted' : 'it looked at'} was not sent: ${it.error})_`;
      parts.push(`${it.from === 'you' ? '**You:**\n' : ''}${shown}`);
      continue;
    }
    if (it.role === 'you') {
      const i = sent.indexOf(it.text);
      if (i >= 0) {
        sent.splice(i, 1);
        continue;
      }
      parts.push(`**You:**\n${it.text.split('\n').map((l) => `> ${l}`).join('\n')}`);
    } else {
      parts.push(it.text);
    }
  }
  return parts.join('\n\n');
}

// While it works, a turn has one live card: a single message, edited in place as the
// agent goes on, so the group shows it is alive without a new message (and a ringing
// phone) every few seconds. The turn's last answer then comes as a new message: you are
// notified when it starts and when it is done. The card holds everything, not a status
// line: a full card is closed and the next one goes on, and a card that cannot be edited
// is sent again as a new one (a repeat, never a loss). It is kept in the cursor
// (`live: {message, text}`), so a restart goes on editing it.
const LIVE_CARD_BYTES = 20000; // a card may hold 30 KB; leave room for JSON escaping
const LIVE_TITLE = '⌛️ Working…';
const FULL_TITLE = '⌛️ Working… (continued below)'; // a full card while the turn goes on
const CLOSED_TITLE = '✅ Worked'; // the turn is over

async function newLive(session, record, text) {
  const parts = chunk(text);
  let res = null;
  for (const [i, part] of parts.entries()) {
    const last = i === parts.length - 1;
    res = await deliver(session, record, (chat) => sendCard(client, chat, textCard(part, last ? LIVE_TITLE : FULL_TITLE, last ? 'blue' : 'grey')));
  }
  return res?.data?.message_id ? { message: res.data.message_id, text: parts[parts.length - 1] } : null;
}

async function addLive(session, record, live, add) {
  if (!live) return newLive(session, record, add);
  const text = `${live.text}\n\n${add}`;
  if (Buffer.byteLength(text) > LIVE_CARD_BYTES) {
    await closeLive(live, FULL_TITLE);
    return newLive(session, record, add);
  }
  try {
    await updateCard(client, live.message, textCard(text, LIVE_TITLE, 'blue'));
    return { message: live.message, text };
  } catch (err) {
    logError(`live card ${live.message} not editable (${err.message}); sending it again`);
    return newLive(session, record, text);
  }
}

async function closeLive(live, title = CLOSED_TITLE) {
  try {
    await updateCard(client, live.message, textCard(live.text, title, 'grey'));
  } catch (err) {
    logError(`live card ${live.message} not closed (${err.message})`); // its text is all there
  }
}

// Images go to Feishu first: each once (by item id), so a post retried after a failure
// does not upload it again. A failed upload fails the post and the cursor stays; after
// UPLOAD_TRIES posts that failed on the same image (too big, a format Feishu refuses),
// the group gets a line saying it was not sent and why, so one image cannot hold back
// everything after it.
const UPLOAD_TRIES = 3;
const uploaded = new Map();
const uploadFailures = new Map();
async function uploadImages(items) {
  for (const it of items) {
    if (it.role !== 'image' || it.key || it.error) continue;
    if (!uploaded.has(it.id)) {
      try {
        uploaded.set(it.id, await uploadImage(client, Buffer.from(it.data, 'base64')));
      } catch (err) {
        const failures = (uploadFailures.get(it.id) || 0) + 1;
        uploadFailures.set(it.id, failures);
        if (failures < UPLOAD_TRIES) throw err;
        it.error = err.message;
        logError(`image ${it.id} not sent after ${failures} tries: ${err.message}`);
        continue;
      }
      if (uploaded.size > 500) uploaded.delete(uploaded.keys().next().value);
    }
    it.key = uploaded.get(it.id);
  }
}

// `live`: a post while it works. Everything goes into the live card, except the turn's
// last answer, which is left for the turn's end (it is not consumed, so nothing is lost).
// Otherwise (turn end, sweep, a dialog, the end): what came before the last answer goes
// into the live card, which is closed, and the answer onward is a new message; with no
// live card, everything is one new message.
async function postItems(session, record, k, cursor, items, reader, file, { live = false } = {}) {
  const answerAt = items.findIndex((it) => it.end);
  const take = live && answerAt >= 0 ? items.slice(0, answerAt) : items;
  if (!take.length && !(cursor.live && !live)) return;
  await uploadImages(take);
  let open = cursor.live || null;
  const head = live ? take : answerAt >= 0 ? take.slice(0, answerAt) : open ? take : [];
  const tail = live ? [] : take.slice(head.length);
  const headText = formatItems(k, head);
  if (headText) open = await addLive(session, record, open, headText);
  if (!live && open) {
    await closeLive(open);
    open = null;
  }
  const tailText = formatItems(k, tail);
  if (tailText) await mentionYou(k, await postTo(session, record, tailText), '✅ done');
  const last = take[take.length - 1];
  saveCursor(k, { ...advance(cursor, take), reader: reader.app, file, ended: last ? last.role === 'ai' && Boolean(last.end) : cursor.ended, live: open });
  if (take.length) log(`<- ${session}/${record.address}: ${take.length} items (${reader.app}${live ? ', live card' : ''})`);
}

// Posts what a terminal said since the last post, through its reader. With
// `waitForEnd`, it first waits for the turn's last answer (hc reports the end before
// the agent writes it). Returns false when the terminal is not readable.
async function postRead(session, address, record, reader, { waitForEnd, live = false }) {
  const k = key(session, address);
  const cursor = cursorOf(k);
  let read = null;
  for (let attempt = 0; attempt < (waitForEnd ? END_TRIES : 1); attempt += 1) {
    read = await reader.after(session, address, cursor);
    if (!read || read.items.some((it) => it.end)) break;
    if (!read.items.length && cursor.ended) break; // the live posts already reached the turn's end
    await sleep(END_WAIT_MS);
  }
  if (!read) return false;
  await postItems(session, record, k, cursor, read.items, reader, read.file, { live });
  return true;
}

async function postTurn(session, address, record) {
  const reader = readerFor(record.status?.app);
  if (reader) {
    try {
      if (await postRead(session, address, record, reader, { waitForEnd: true })) return;
    } catch (err) {
      logError(`${session}/${address}: ${reader.app} not readable (${err.message}); posting the screen`);
    }
  }
  await mentionYou(key(session, address), await postTo(session, record, await screen(session, address, TURN_SCREEN_LINES)), '✅ done');
  log(`<- ${session}/${address}: screen`);
}

// The program is gone: post what its log still holds, then say it ended.
async function postEnd(session, address, record, reason) {
  const k = key(session, address);
  const cursor = cursorOf(k);
  const reader = readerFor(cursor.reader);
  if (reader && cursor.file) {
    try {
      await postItems(session, record, k, cursor, await reader.rest(session, address, cursor), reader, cursor.file);
    } catch (err) {
      logError(`${session}/${address}: last ${reader.app} entries not readable (${err.message})`);
    }
  }
  await postTo(session, record, `🔚 **Terminal ended**${reason ? ` (${reason})` : ''}`);
  await markDone(k);
  await endChat(k);
  // a new terminal that came up in the same tab while this one still ran takes the group now
  const tab = readState().chats[k]?.tab;
  const next = tab && [...(views.get(session)?.terminals.values() || [])].find((t) => t.state === 'live' && t.address !== address && t.labels?.['herdr.tab'] === tab);
  if (next) later(session, next.address, 'group', () => ensureChat(session, next));
}

// ---------- dialogs: it waits for you ----------

// What each dialog card showed, by message id, so an answered card keeps it.
const dialogCards = new Map();

function remember(messageId, shown) {
  dialogCards.set(messageId, shown);
  if (dialogCards.size > 200) dialogCards.delete(dialogCards.keys().next().value);
}

// With a menu, the card shows only the dialog, as plain text that wraps on a phone (the
// screen above it was posted already, and the options are the buttons); without one,
// the screen is all there is to go by.
const escapeMarkdown = (text) => text.replace(/[\\`*_[\]#>~|]/g, '\\$&');

// A card that needs you says so first thing, so the chat list shows it at a glance; once
// it no longer waits, it says that instead (the card's last line says why).
const NEEDS_TITLE = '⚠️ Needs you';
const DIALOG_LINES = 15;
const DONE_TITLE = '✅ Done';

function dialogOf(status, screenText) {
  const menu = menuOf(screenText);
  const title = `${NEEDS_TITLE}${status?.kind ? ` (${status.kind})` : ''}`;
  // no options to read: the dialog is at the bottom, so its last lines, without blank ones
  const markdown = menu ? escapeMarkdown(menu.text) : `\`\`\`\n${tidyScreen(screenText, DIALOG_LINES)}\n\`\`\``;
  return { menu, title, markdown };
}

function dialogCard(session, address, { menu, title, markdown }) {
  return menuCard({ title, markdown, menu, value: { s: session, a: address, k: menu.key } });
}

// It waits for you (permission, question, auth). When its screen holds a numbered menu,
// the card has a button per option; otherwise it shows the screen and how to answer by
// typing.
// One dialog gets one card. A dialog is named by its menu key (or, with no menu, by its
// status words); the name is claimed before anything is sent, so the turn event, a
// status event and a card click that all see the same dialog post it once. Leaving
// `blocked` forgets it, so the same dialog asked again later gets a card again.
const postedDialog = new Map(); // terminal key -> name of the dialog last posted

const dialogName = (dialog, status) => (dialog.menu ? dialog.menu.key : `${status?.kind || ''}|${status?.msg || ''}`);

function claimDialog(k, dialog, status) {
  const name = dialogName(dialog, status);
  if (postedDialog.get(k) === name) return false;
  postedDialog.set(k, name);
  return true;
}

// The dialog card still waiting, per terminal. When its dialog goes away (answered in the
// terminal, or the program moved on to the next one), the card drops its buttons and
// says so, so the group never shows a question nobody waits on. A card being clicked
// is not open: its click answers it.
const openCard = new Map(); // terminal key -> {message, dialog}

async function closeCard(k, done) {
  const open = openCard.get(k);
  if (!open) return;
  openCard.delete(k);
  try {
    await updateCard(client, open.message, doneCard(DONE_TITLE, open.dialog.markdown, done));
  } catch (err) {
    logError(`dialog card ${open.message} not closed (${err.message})`);
  }
}

// `screen`: the screen read when the event came (a promise), so a dialog answered in
// the terminal while earlier work was still being posted still gets its card. `again`:
// post it even if it was posted (you typed in the group while it waits).
// A screen read the moment `blocked` arrives may come before the dialog is drawn: with no
// menu on it, the screen is read again a few times.
const DRAW_TRIES = 3;
const DRAW_WAIT_MS = 400;

async function postBlocked(session, address, record, { screen = null, again = false } = {}) {
  const first = await screen;
  let dialog = first ? dialogOf(record.status, first) : null;
  for (let i = 0; i < DRAW_TRIES && !dialog?.menu; i += 1) {
    if (i) await sleep(DRAW_WAIT_MS);
    dialog = dialogOf(record.status, await screenTail(session, address, SCREEN_LINES));
  }
  const k = key(session, address);
  if (!claimDialog(k, dialog, record.status) && !again) return;
  await closeCard(k, 'It moved on; see the next card.');
  if (!dialog.menu) {
    const sent = await postTo(session, record, `**${dialog.title}**\n\n${dialog.markdown}\n\nReply \`/answer <text>\` to answer it, or \`/esc\` to cancel it.`);
    const chat = readState().chats[k]?.chat;
    if (chat) await pinChat(k, chat);
    await mentionYou(k, sent, '⚠️ needs you');
  } else {
    const res = await deliver(session, record, (chat) => sendCard(client, chat, dialogCard(session, address, dialog)));
    if (res?.data?.message_id) {
      remember(res.data.message_id, dialog);
      openCard.set(k, { message: res.data.message_id, dialog });
      await pinChat(k, res.data.chat_id);
      await mentionYou(k, res.data.message_id, '⚠️ needs you');
      // answered while the card was on its way: nothing will close it later, so now
      const live = views.get(session)?.terminals.get(address);
      if (live?.status?.state !== 'blocked' || postedDialog.get(k) !== dialogName(dialog, record.status)) await closeCard(k, '✔ Answered.');
    }
  }
  log(`<- ${session}/${address}: blocked${dialog.menu ? ` (${dialog.menu.options.length} options)` : ''}`);
}

// "Type something": pick that option, then type the words.
async function answerFree(session, address, menu, text) {
  await keys(session, address, [String(menu.free.n)]);
  await sleep(300);
  await send(session, address, text, { force: true });
}

const toast = (type, content) => ({ toast: { type, content } });
const answered = (shown, done) => ({ ...toast('info', done), card: { type: 'raw', data: doneCard(DONE_TITLE, shown.markdown, done) } });

// A click on a dialog card. The screen is read again first, and nothing is pressed
// unless it still shows the dialog the card was made from (same key) with the same
// option. After the key, the card turns into the dialog's next step (the next question,
// the review, a toggled box) or says what was picked.
async function onCardAction(data) {
  const started = Date.now();
  if (data.operator?.open_id !== cfg.ownerOpenId) return toast('error', 'Only the owner can answer.');
  const v = data.action?.value || {};
  const messageId = data.context?.open_message_id;
  const shown = dialogCards.get(messageId) || { title: NEEDS_TITLE, markdown: '' };
  const record = views.get(v.s)?.terminals.get(v.a);
  if (!record || record.state !== 'live') return answered(shown, 'The terminal has ended.');
  const status = (await getTerminal(v.s, v.a)).status;
  const menu = status?.state === 'blocked' ? menuOf(await screenTail(v.s, v.a, SCREEN_LINES)) : null;
  if (!menu || menu.key !== v.k) {
    if (menu) later(v.s, v.a, 'dialog', () => postBlocked(v.s, v.a, { ...record, status }));
    return answered(shown, menu ? 'It now asks something else; see the new card.' : 'It no longer waits on this.');
  }

  const k = key(v.s, v.a);
  if (openCard.get(k)?.message === messageId) openCard.delete(k);
  let picked;
  if (v.pick === 'esc' || v.pick === 'tab') {
    await keys(v.s, v.a, [v.pick]);
    picked = v.pick === 'esc' ? 'Esc pressed' : 'Next';
  } else {
    const option = menu.options.find((o) => o.n === v.pick);
    if (!option || option.label !== v.label) return answered(shown, 'The options changed; nothing was pressed.');
    if (option === menu.free) {
      const text = String(data.action?.form_value?.answer || '').trim();
      if (!text) return toast('warning', 'Type your answer first.');
      await answerFree(v.s, v.a, menu, text);
      picked = text;
    } else {
      await keys(v.s, v.a, [String(option.n)]);
      picked = `${option.n}. ${option.label}`;
    }
  }
  log(`-> ${v.s}/${v.a}: picked ${picked}`);

  // A slow machine: answer the click now, show the next step as a new card after.
  if (Date.now() - started > CLICK_BUDGET_MS) {
    later(v.s, v.a, 'dialog', async () => {
      await sleep(KEY_SETTLE_MS);
      const next = (await getTerminal(v.s, v.a)).status;
      if (next?.state === 'blocked') await postBlocked(v.s, v.a, { ...record, status: next });
    });
    return answered(shown, `✔ ${picked}`);
  }
  await sleep(KEY_SETTLE_MS);
  const nextStatus = (await getTerminal(v.s, v.a)).status;
  if (nextStatus?.state === 'blocked') {
    const next = dialogOf(nextStatus, await screenTail(v.s, v.a, SCREEN_LINES));
    // the same dialog (a toggled box) is redrawn here; a new one only if no card has it yet
    if (next.menu && (next.menu.key === v.k || claimDialog(k, next, nextStatus))) {
      remember(messageId, next);
      openCard.set(k, { message: messageId, dialog: next });
      return { ...toast('info', `✔ ${picked}`), card: { type: 'raw', data: dialogCard(v.s, v.a, next) } };
    }
    if (next.menu) return answered(shown, `✔ ${picked}`); // its card is out already
    // still waiting, on something with no menu: hc sends no new turn for it, so post it
    later(v.s, v.a, 'dialog', () => postBlocked(v.s, v.a, { ...record, status: nextStatus }));
  }
  return answered(shown, `✔ ${picked}`);
}

// Shown terminals this session runs whose program has a reader, with that reader.
function readable(session) {
  return [...(views.get(session)?.terminals.values() || [])]
    .filter((record) => shownWhere(record) && handles(session, record.address))
    .map((record) => ({ record, reader: agentOf(record) }))
    .filter((x) => x.reader);
}

// A missed turn event (bot down, event stream reconnected) or a turn posted before its
// last answer was written would leave content behind; idle readable terminals are
// checked again at start, after every snapshot and every SWEEP_MS.
function sweep(session) {
  for (const { record, reader } of readable(session)) {
    if (['working', 'blocked'].includes(record.status?.state)) continue;
    later(session, record.address, 'sweep', async () => {
      await postRead(session, record.address, record, reader, { waitForEnd: false });
      await markDone(key(session, record.address), { olderThan: SWEEP_DONE_MS }); // a turn end that was missed
    });
  }
}

// While a readable terminal works, what it says and does is posted every LIVE_MS, so
// the group shows it is alive; the turn's end then posts the rest. One check per
// terminal at a time.
const liveBusy = new Set();
function live(session) {
  for (const { record, reader } of readable(session)) {
    if (record.status?.state !== 'working') continue;
    const k = key(session, record.address);
    if (liveBusy.has(k)) continue;
    liveBusy.add(k);
    later(session, record.address, 'live', () => postRead(session, record.address, record, reader, { waitForEnd: false, live: true })).finally(() => liveBusy.delete(k));
  }
}

// hc sends a turn event only when a program leaves `working`. A program that goes from
// one dialog straight to the next (a permission, then a question) never works in
// between, so the status events catch that: blocked, and not coming from working
// (that case is the turn event's, which posts what it said first).
const lastState = new Map(); // terminal key -> status state at the last status event

function onStatus(session, address, record) {
  const k = key(session, address);
  const was = lastState.get(k);
  const now = record.status?.state;
  lastState.set(k, now);
  if (now !== was) since.set(k, Date.now());
  if (now !== 'blocked') {
    postedDialog.delete(k);
    if (readState().pinned?.[k]) later(session, address, 'unpin', () => unpinChat(k));
    if (openCard.has(k)) later(session, address, 'dialog', () => closeCard(k, '✔ Answered.'));
    return;
  }
  if (was === 'working' || !shownWhere(record) || !handles(session, address) || !agentOf(record)) return;
  // the screen and the status as they are now: by the time the lane gets to it, the
  // dialog may be answered and the status moved on
  const screen = screenTail(session, address, SCREEN_LINES).catch(() => null);
  const status = { ...record.status };
  later(session, address, 'dialog', () => postBlocked(session, address, { ...record, status }, { screen }));
}

function watch(session) {
  const view = followEvents(session, {
    log,
    onSnapshot: (list) => {
      firstSnapshot.get(session).done();
      scheduleOverview();
      for (const record of list) if (shownWhere(record)) later(session, record.address, 'group', () => ensureChat(session, record));
      setTimeout(() => sweep(session), 0); // after views has this session's records
    },
    onChange: ({ type, address, record, data }) => {
      scheduleOverview();
      if (type === 'status' && record) onStatus(session, address, record);
      if (['created', 'restarted', 'labels', 'status', 'title'].includes(type) && shownWhere(record)) {
        later(session, address, 'group', () => ensureChat(session, record));
      } else if ((type === 'finished' || type === 'removed') && chatOf(session, address)?.session === session) {
        later(session, address, 'end', () => postEnd(session, address, record || { address }, data?.reason));
      }
    },
    onTurn: ({ address, state, record }) => {
      scheduleOverview();
      log(`turn ${session}/${address}: ${state}${shownWhere(record) ? '' : ' (not shown in herdr-app)'}`);
      // a group mirrors agents: a shell or another program posts nothing by itself
      if (!shownWhere(record) || !handles(session, address) || !agentOf(record)) return;
      const screen = state === 'blocked' ? screenTail(session, address, SCREEN_LINES).catch(() => null) : null;
      const status = { ...record.status };
      later(session, address, 'turn', async () => {
        if (state === 'blocked') {
          // what it said before stopping to ask comes first
          const reader = agentOf(record);
          if (reader) await postRead(session, address, record, reader, { waitForEnd: false }).catch(() => {});
          await postBlocked(session, address, { ...record, status }, { screen });
          return;
        }
        await postTurn(session, address, record);
        await markDone(key(session, address));
      });
    },
  });
  views.set(session, view);
}

// ---------- Feishu in ----------

const seen = new Set();

// What you sent did not reach the terminal: said plainly, never a raw hc error.
const ENDED_REPLY = 'Not delivered: this terminal has ended. Nothing you send here reaches it.';

async function reply(chatId, text) {
  await sendMarkdown(client, chatId, text);
}

// What you sent from a group is marked with a reaction: THINKING once it is typed into
// the terminal, swapped for OK when the turn that took it is over (the turn ends, a
// shell shows what the command did, or the terminal ends). A dialog in between is not
// the end. Which messages wait for their OK is kept in state.json (reacts), so a
// restart still marks them. Reactions are a nicety: a failure is only logged.
const WORKING_EMOJI = 'THINKING';
const DONE_EMOJI = 'OK';

async function addReaction(messageId, emoji) {
  const res = await client.im.v1.messageReaction.create({ path: { message_id: messageId }, data: { reaction_type: { emoji_type: emoji } } });
  return res?.data?.reaction_id;
}

async function markWorking(k, messageId) {
  try {
    const reaction = await addReaction(messageId, WORKING_EMOJI);
    const state = readState();
    state.reacts = { ...(state.reacts || {}), [k]: [...(state.reacts?.[k] || []), { message: messageId, reaction, at: Date.now() }] };
    writeState(state);
  } catch (err) {
    logError(`reaction on ${messageId}: ${err.message}`);
  }
}

// `olderThan`: only messages typed in at least this long ago (the sweep: a message just
// typed in may not have started a turn yet).
async function markDone(k, { olderThan = 0 } = {}) {
  const all = readState().reacts?.[k] || [];
  const waiting = all.filter((x) => Date.now() - (x.at || 0) >= olderThan);
  if (!waiting.length) return;
  const state = readState();
  const left = (state.reacts?.[k] || []).filter((x) => !waiting.some((w) => w.message === x.message));
  if (left.length) state.reacts[k] = left;
  else delete state.reacts[k];
  writeState(state);
  for (const { message, reaction } of waiting) {
    try {
      if (reaction) await client.im.v1.messageReaction.delete({ path: { message_id: message, reaction_id: reaction } });
      await addReaction(message, DONE_EMOJI);
    } catch (err) {
      logError(`reaction on ${message}: ${err.message}`);
    }
  }
}

async function typeInto(chatId, messageId, session, address, text) {
  const record = views.get(session)?.terminals.get(address);
  if (!record || record.state !== 'live') {
    await reply(chatId, ENDED_REPLY);
    return;
  }
  const agent = agentOf(record);
  if (text === '/screen' || text === '/esc') {
    if (text === '/esc') await keys(session, address, ['esc']);
    await reply(chatId, `${text === '/esc' ? 'Esc pressed.\n\n' : ''}${await screen(session, address)}`);
    return;
  }
  const answer = text.match(/^\/answer\s+([\s\S]+)$/);
  if (!answer && agent && record.status?.state === 'blocked') {
    // It waits on a dialog: words go into its "Type something" box when it has one;
    // otherwise the dialog card comes again, to pick there.
    const menu = menuOf(await screenTail(session, address, SCREEN_LINES));
    if (menu?.free) {
      await answerFree(session, address, menu, text);
      log(`-> ${session}/${address}: answered ${text.slice(0, 80)}`);
      await markWorking(key(session, address), messageId);
    } else {
      await postBlocked(session, address, record, { again: true });
    }
    return;
  }
  try {
    const typed = answer ? answer[1] : text;
    await send(session, address, typed, { force: Boolean(answer) });
    const k = key(session, address);
    fromFeishu.set(k, [...(fromFeishu.get(k) || []).slice(-20), typed.trim()]);
    log(`-> ${session}/${address}: ${text.slice(0, 80)}`);
    await markWorking(key(session, address), messageId);
  } catch (err) {
    const hint = /blocked/i.test(err.message) ? '\n\nIt waits on a dialog. Reply `/answer <text>` to answer it, or `/esc` to cancel it.' : '';
    await reply(chatId, `Not delivered: ${plainError(err)}\n\n${await screen(session, address)}${hint}`);
    return;
  }
  // Anything but an agent posts nothing by itself: what you typed gets one look at its
  // screen in reply.
  if (!agent) {
    await sleep(SHELL_ECHO_MS);
    await reply(chatId, await screen(session, address));
    await markDone(key(session, address));
  }
}

// Images you send to a group: saved here, sent beside the terminal (on its machine) with
// `hc put`, and typed in as their paths, which an agent like Claude Code opens.
const INBOX = path.join(os.tmpdir(), 'herdrchat-inbox');

function extOf(head) {
  if (head[0] === 0x89 && head.toString('latin1', 1, 4) === 'PNG') return 'png';
  if (head[0] === 0xff && head[1] === 0xd8) return 'jpg';
  if (head.toString('latin1', 0, 4) === 'GIF8') return 'gif';
  if (head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return 'png';
}

async function imagesInto(messageId, session, address, imageKeys) {
  fs.mkdirSync(INBOX, { recursive: true });
  const landed = [];
  for (const [i, imageKey] of imageKeys.entries()) {
    const raw = path.join(INBOX, `${messageId}-${i}`);
    await downloadImage(client, messageId, imageKey, raw);
    const file = `${raw}.${extOf(fs.readFileSync(raw).subarray(0, 12))}`;
    fs.renameSync(raw, file);
    landed.push(await put(session, address, file));
    fs.unlinkSync(file); // the terminal has its own copy now
  }
  return landed;
}

// ---------- the overview, in the direct chat ----------

// The overview card (lib/overview.mjs) is edited whenever a terminal changes; changes
// within OVERVIEW_WAIT_MS make one edit, and an edit that would change nothing is
// skipped. Which message it is lives in state.json (overview). `/ls` sends a new one at
// the bottom of the chat and the old one points to it.
const OVERVIEW_WAIT_MS = 2000;
const since = new Map(); // terminal key -> when its status state last changed
let overviewTimer = null;
let overviewShown = null;

function overviewRows() {
  const rows = [];
  for (const session of cfg.sessions) {
    for (const record of views.get(session)?.terminals.values() || []) {
      const where = shownWhere(record);
      if (!where || !handles(session, record.address)) continue;
      const k = key(session, record.address);
      rows.push({
        name: groupName(where, record),
        address: session === cfg.sessions[0] || machineOf(record.address) ? record.address : `${session} ${record.address}`,
        state: record.status?.state,
        kind: record.status?.kind,
        program: record.foreground?.name || record.agent,
        since: since.get(k),
        chat: readState().chats[k]?.chat,
      });
    }
  }
  return rows;
}

async function sendOverview(card) {
  const res = await sendCard(client, cfg.ownerOpenId, card, 'open_id');
  const state = readState();
  state.overview = { message: res.data.message_id };
  writeState(state);
}

// There is one overview. An edit that fails is tried again (Feishu sometimes answers
// 500 for a moment); only when it keeps failing, or on `/ls`, a new one is sent, and the
// old one is recalled, so the chat never shows two.
const OVERVIEW_TRIES = 3;

async function refreshOverview({ fresh = false } = {}) {
  if (!cfg.ownerOpenId) return;
  const rows = overviewRows();
  const text = overviewText(rows);
  if (text === overviewShown && !fresh) return;
  const card = overviewCard(rows, Date.now());
  const old = readState().overview?.message;
  if (old && !fresh) {
    for (let attempt = 1; attempt <= OVERVIEW_TRIES; attempt += 1) {
      try {
        await updateCard(client, old, card);
        overviewShown = text;
        return;
      } catch (err) {
        logWarn(`overview ${old} not edited (${err.message}); ${attempt < OVERVIEW_TRIES ? 'trying again' : 'sending a new one'}`);
        if (attempt < OVERVIEW_TRIES) await sleep(1000 * 2 ** attempt);
      }
    }
  }
  await sendOverview(card);
  overviewShown = text;
  if (old) await recallMessage(client, old).catch((err) => logError(`old overview ${old} not recalled (${err.message})`));
}

function scheduleOverview() {
  if (overviewTimer) return;
  overviewTimer = setTimeout(() => {
    overviewTimer = null;
    refreshOverview().catch((err) => logError(`overview: ${err.message}`));
  }, OVERVIEW_WAIT_MS);
}

const HELP = [
  '`/ls` a new overview of every terminal (the overview also keeps itself up to date)',
  '`/new <session> <space>/<tab> [command]` start a terminal (default `claude`); `--cwd <dir>` first to pick its folder',
  '`/kill <session> <address>` end a terminal',
  '`/auth` let the bot act as you for chat-list settings (mute, labels, pin)',
  'In a terminal\'s group: type to talk to it; `/screen`, `/answer <text>`, `/esc`.',
].join('\n');

async function newTerminal(args) {
  let cwd = null;
  if (args[0] === '--cwd') {
    cwd = args[1];
    args = args.slice(2);
  }
  const [session, place, ...command] = args;
  if (!cfg.sessions.includes(session)) throw new Error(`unknown session "${session}"; known: ${cfg.sessions.join(', ')}`);
  const slash = (place || '').indexOf('/');
  if (slash < 1 || slash === place.length - 1) throw new Error('give the place as <space>/<tab>');
  const space = place.slice(0, slash);
  const tab = place.slice(slash + 1);
  const sibling = [...views.get(session).terminals.values()].find((t) => shownWhere(t)?.space === space && t.labels?.['herdr.space']);
  const spaceId = sibling?.labels['herdr.space'] || `sp${crypto.randomBytes(16).toString('hex')}`;
  const folder = cwd || sibling?.foreground?.cwd || sibling?.cwd || os.homedir();
  const line = command.length ? command.join(' ') : 'claude';
  const out = await run(session, {
    cwd: folder,
    labels: { 'herdr.space': spaceId, 'herdr.tab': `tb${crypto.randomBytes(16).toString('hex')}`, where: `${space} / ${tab}` },
    argv: ['/bin/zsh', '-lc', `exec ${line}`], // login shell for PATH; exec so no bare shell is left behind
  });
  const address = JSON.parse(out).address;
  return `Started \`${line}\` as \`${address}\` in ${session} / ${space} / ${tab} (\`${folder}\`). Its group appears in a moment.`;
}

// `/auth`: the device flow, in the direct chat. The link opens Feishu's own consent page;
// the bot waits for your yes in the background.
async function authorize(chatId) {
  const device = await userAuth.startDeviceFlow();
  await reply(chatId, `Open this link and allow it (the code is ${device.user_code}):\n\n${device.verification_uri_complete || device.verification_uri}\n\nIt lets the bot mute its groups for you, put them in your labels and pin the one that needs you. Nothing else.`);
  userAuth.waitForToken(device)
    .then(async (t) => {
      await reply(chatId, `✅ Allowed${t.refresh ? '' : ' (no refresh token: it lasts about two hours)'}. Muting the groups and putting them in your labels now.`);
      youCheckedAt = 0;
      await asYou();
    })
    .catch((err) => reply(chatId, `Not allowed: ${err.message}`));
}

async function admin(chatId, text) {
  const [cmd, ...args] = text.split(/\s+/);
  if (cmd === '/ls') return refreshOverview({ fresh: true });
  if (cmd === '/auth') return authorize(chatId);
  if (cmd === '/new') return reply(chatId, await newTerminal(args));
  if (cmd === '/kill') {
    const [session, address] = args;
    if (!cfg.sessions.includes(session) || !address) throw new Error('give `/kill <session> <address>`');
    await hc(session, ['kill', address]);
    return reply(chatId, `Ended \`${address}\` in ${session}.`);
  }
  return reply(chatId, HELP);
}

async function onMessage(data) {
  const msg = data.message;
  if (seen.has(msg.message_id)) return;
  seen.add(msg.message_id);
  if (seen.size > 1000) seen.delete(seen.values().next().value);

  const openId = data.sender?.sender_id?.open_id;
  if (!cfg.ownerOpenId) {
    log(`owner not set; message from open_id ${openId}`);
    if (msg.chat_type === 'p2p') await reply(msg.chat_id, `Owner is not set. Put this in ${CONFIG_FILE}:\n\n\`FEISHU_OWNER_OPEN_ID=${openId}\`\n\nthen restart the bot.`);
    return;
  }
  if (openId !== cfg.ownerOpenId) {
    logWarn(`ignored message from ${openId}`);
    return;
  }
  const parts = messageParts(msg.message_type, msg.content);
  if (!parts) {
    await reply(msg.chat_id, 'Only text and images are passed on.');
    return;
  }
  const text = parts.text.replace(/@_user_\d+/g, '').trim();
  if (!text && !parts.images.length) return;

  try {
    if (msg.chat_type === 'p2p') {
      if (parts.images.length) await reply(msg.chat_id, 'Send images in a terminal\'s group.');
      else await admin(msg.chat_id, text);
      return;
    }
    const target = terminalOfChat(msg.chat_id);
    if (!target) {
      log(`message in a group this bot did not make: ${msg.chat_id}${msg.thread_id ? ` (thread ${msg.thread_id})` : ''}`);
      return;
    }
    if (views.get(target.session)?.terminals.get(target.address)?.state !== 'live') {
      await reply(msg.chat_id, ENDED_REPLY);
      return;
    }
    const files = await imagesInto(msg.message_id, target.session, target.address, parts.images);
    await typeInto(msg.chat_id, msg.message_id, target.session, target.address, [text, ...files].filter(Boolean).join(' '));
  } catch (err) {
    logError(`message to ${msg.chat_id}:`, err);
    await reply(msg.chat_id, `Not delivered: ${plainError(err)}`);
  }
}

// ---------- start ----------

log(`herdrchat: sessions ${cfg.sessions.join(', ')}`);
if (!cfg.ownerOpenId) log('owner not set: no groups are made until it is. Send the bot any direct message.');
startEvents(cfg, onMessage, onCardAction, () => sayBack().catch((err) => logError(`back notice: ${err.message}`)));
for (const session of cfg.sessions) watch(session);
ready.then(() => setTimeout(async () => {
  await endGone().catch((err) => logError(`end gone groups: ${err.message}`));
  if (await asYou()) {
    // pins left from before a restart, for terminals that no longer wait
    for (const k of Object.keys(readState().pinned || {})) {
      const address = addressOfKey(k);
      if (!cfg.sessions.some((s) => views.get(s)?.terminals.get(address)?.status?.state === 'blocked')) await unpinChat(k);
    }
  }
}, 0));
setInterval(() => asYou().catch((err) => logError(`as you: ${err.message}`)), YOU_CHECK_MS);
setInterval(() => readCores().then(() => cfg.sessions.forEach(sweep)), SWEEP_MS);
setInterval(() => cfg.sessions.forEach(live), LIVE_MS);
