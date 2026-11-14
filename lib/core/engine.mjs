// herdrchat's core, the same for every chat app: one room per herdr-app tab (a group in
// Feishu, a topic in Telegram) for every hc session in HERDR_SESSIONS; what you type in a
// room goes to its terminal; the direct chat with the bot is herdr itself (/ls, /new,
// /kill). hc is the backbone: its events say which terminals exist, their status and
// when a turn ends. What an agent said comes from its reader (readers/: the agent's own
// records, posted live while it works); anything but a running agent posts nothing by
// itself. Only what happens after the bot starts is posted, never older history.
//
// The chat side (lib/chats/<app>/index.mjs) gives:
//   ready()                       the owner is known (else no room is made)
//   start({onMessage, onAction, onReady})  messages {room|null, where, message, text, images}
//                                 (room null: the direct chat) and button clicks
//                                 {value, message, answer} -> {toast: {type, text}, card?}
//   help, command(cmd, args, where)  its own direct-chat commands
//   openRoom({name, intro}) -> room; renameRoom(room, name)
//   placeRoom(k, {space}); endRoom(k); reviveRoom(k)  what a live or ended room looks like
//   post(room, markdown, {footer}) -> message; reply(where, markdown)
//   postCard(room, look) -> message; editCard(message, look)   look: {title, tone, markdown, footer}
//   postDialog(room, dialog, value) -> message; closeDialog(message, dialog, done)
//                                 a footer (also dialog.footer) is one small line under a post:
//                                 the harness and model it came from, as herdrchat knows them
//   pin(k, room, message); unpin(k); pinned() -> keys; ring(k, message, text)
//   markWorking(message) -> token; markDone(message, token)
//   image(buffer) -> markdown; download(message, ref, file)
//   postFile(room, {name, data, caption}); postFolded(room, {title, markdown}); foldedBytes
//   tellOwner(look); showOverview(rows, {fresh}); split(text) -> parts; liveBytes
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LABEL, askOf, askOpen, asksHere } from './asks.mjs';
import { advance, startCursor } from './cursor.mjs';
import { isUnavailable, machineOf, plainError, splitWhere, tidyScreen } from './hc.mjs';
import { homeShell } from './home.mjs';
import { menuOf } from './menu.mjs';
import { branchOf, footerWords } from './meter.mjs';
import { coreViews } from './views.mjs';

const SHELL_ECHO_MS = 1500;
const SCREEN_LINES = 40;
const TURN_SCREEN_LINES = 150;
const POST_TRIES = 5;
const SWEEP_MS = 60 * 1000;
const SWEEP_DONE_MS = 30 * 1000;
const LIVE_MS = 5000;
const ASKS_MS = 2000;
const END_TRIES = 20;
const END_WAIT_MS = 750;
const KEY_SETTLE_MS = 700; // a dialog redraws this soon after a key
const CLICK_BUDGET_MS = 2000; // a click must be answered within 3 s
const OVERVIEW_WAIT_MS = 2000;
const UPLOAD_TRIES = 3;
const DRAW_TRIES = 5;
const BOX_GAP_MS = 120; // between two boxes pressed for one Next
const DRAW_WAIT_MS = 400;
const TITLE_MAX = 40;
const DIALOG_LINES = 15;
const NEEDS_TITLE = '⚠️ Needs you';
const DONE_TITLE = '✅ Done';
const LIVE_TITLE = '⌛️ Working…';
const FULL_TITLE = '⌛️ Working… (continued below)'; // a full card while the turn goes on
const CLOSED_TITLE = '✅ Worked'; // the turn is over
const ENDED_REPLY = 'Not delivered: this terminal has ended. Nothing you send here reaches it.';
const WAIT = Symbol('wait');
const FILE_BYTES = 20 * 1000 * 1000;

// hc: {followEvents, cores, machines, getTerminal, screenTail, send, keys, put, run, kill,
// nameTab?(tabId, name): name a tab in herdr-app, when it runs here};
// readers: {agentOf, readerFor}; store: {read, write} of state.json; inbox: a folder for
// images on their way to a terminal; quick: shorter waits (tests).
export function createEngine({ cfg, chat, hc, readers, store, log, logWarn, logError, startedAt = new Date().toISOString(), inbox = path.join(os.tmpdir(), 'herdrchat-inbox'), quick = false, asksWaiting = asksHere, askLives = askOpen, shell = homeShell }) {
  const { read, write } = store;
  const { agentOf, readerFor } = readers;
  const sleep = (ms) => new Promise((r) => setTimeout(r, quick ? Math.min(ms, 5) : ms));

  const views = new Map(); // session -> followEvents handle (its live terminal records)

  // ---------- which view follows a terminal ----------

  // One terminal can be seen through several sessions (views.mjs): hc's core ids say
  // which views are the same terminal, and only one of them is followed. They are read at
  // start and again every SWEEP_MS, as machines come and go.
  let topology = coreViews(cfg.sessions, new Map());

  // A machine that cannot be reached (its link down, or hc says "unavailable") is said
  // once when it goes and once when it is back; meanwhile its terminals are not checked.
  const unreachable = new Set(); // "<session>|<machine>"
  function machineDown(session, machine, why) {
    const id = `${session}|${machine}`;
    if (unreachable.has(id)) return;
    unreachable.add(id);
    logWarn(`machine ${machine} (seen from ${session}) is unreachable; its terminals wait until it is back${why ? `: ${why}` : ''}`);
  }
  function reachable(session, address) {
    const machine = machineOf(address)?.split('/')[0];
    return !machine || (!unreachable.has(`${session}|${machine}`) && topology.reachable(session, address));
  }

  async function readCores() {
    const found = new Map();
    for (const session of cfg.sessions) {
      try {
        found.set(session, await hc.cores(session));
      } catch (err) {
        logWarn(`cores of ${session}: ${err.message}`);
      }
    }
    topology = coreViews(cfg.sessions, found);
    for (const [session, info] of found) {
      for (const link of info.links) {
        const id = `${session}|${link.name}`;
        if (link.state !== 'connected') machineDown(session, link.name, link.state);
        else if (unreachable.delete(id)) log(`machine ${link.name} (seen from ${session}) is back`);
      }
    }
  }

  // A terminal's key in state.json is "<session>|tN", or "@<machine>|<machine>/tN" for one
  // on another machine, as named by the view that follows it.
  const scopeOf = (session, address) => machineOf(address) || session;
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

  // ---------- lanes ----------

  // Work for one terminal runs one at a time, in order (its lane): no races on its room
  // or its cursor. Terminals do not wait for each other. Nothing runs before every
  // session's first snapshot and the cores are in, so a terminal on another machine is
  // claimed by the same session every time.
  const firstSnapshot = new Map(cfg.sessions.map((s) => {
    let done;
    const promise = new Promise((r) => { done = r; });
    return [s, { promise, done }];
  }));
  let coresRead = Promise.resolve();
  let ready = Promise.resolve();
  const lanes = new Map(); // terminal key -> its last queued work
  function laneOf(k, label, fn) {
    const next = (lanes.get(k) || ready).then(fn).catch((err) => {
      const address = addressOfKey(k);
      if (isUnavailable(err) && machineOf(address)) machineDown(scopeOfKey(k), machineOf(address).split('/')[0], plainError(err));
      else logError(`${label} ${address}:`, err);
    });
    lanes.set(k, next);
    next.then(() => { if (lanes.get(k) === next) lanes.delete(k); });
    return next;
  }
  const later = (session, address, label, fn) => laneOf(key(session, address), label, fn);

  // ---------- rooms ----------

  const shownWhere = (record) => (record && record.state === 'live' ? splitWhere(record.labels?.where) : null);

  // A room is named after where herdr-app shows the terminal. A tab herdr-app only
  // numbered ("2") says nothing, so the terminal's title stands in for it (what Claude
  // Code sets as its session name or topic), then its hc name; leading status glyphs are
  // dropped, so a spinner in a title never renames a room.
  function tabName(where, record) {
    if (!/^\d+$/.test(where.tab)) return where.tab;
    // an agent whose title holds more than a name (Codex: "<thread> | <folder>") says which part
    const titled = agentOf(record)?.titleOf?.(record.title) ?? record.title;
    const title = String(titled || '').replace(/^[^\p{L}\p{N}]+/u, '').replace(/\s+/g, ' ').trim();
    const name = title || record.name || '';
    if (!name) return where.tab;
    return name.length > TITLE_MAX ? `${name.slice(0, TITLE_MAX - 1)}…` : name;
  }
  const roomName = (where, record) => `${where.space} / ${tabName(where, record)}`;

  function setRoom(k, fields) {
    const state = read();
    if (state.chats[k]) state.chats[k] = { ...state.chats[k], ...fields };
    write(state);
  }

  const roomOf = (session, address) => read().chats[key(session, address)];

  function terminalOfRoom(room) {
    for (const [k, v] of Object.entries(read().chats)) {
      if (v.chat === room) return { session: v.session, address: addressOfKey(k) };
    }
    return null;
  }

  // A room belongs to a herdr-app tab, by the tab's id (`herdr.tab`), not to the terminal
  // that happens to run in it: when the terminal is replaced (Claude quit and the tab got
  // a new shell, a program was started again), the new one takes over the tab's room once
  // the old one is gone. A tab that was deleted and made again has a new id, so a new
  // room. Returns the room, null (none: make one), or WAIT (the old terminal still runs:
  // its end hands the room over, see postEnd). The old terminal's last words go first.
  async function adoptTabRoom(k, tab) {
    const before = Object.entries(read().chats).find(([ok, c]) => ok !== k && c.tab === tab && scopeOfKey(ok) === scopeOfKey(k));
    if (!before) return null;
    const [ok, was] = before;
    if (views.get(was.session)?.terminals.get(addressOfKey(ok))?.state === 'live') return WAIT;
    await lanes.get(ok)?.catch(() => {}); // its end (postEnd) runs to the last item
    const state = read();
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
    write(state);
    log(`room ${old.name} (${old.chat}) now follows ${addressOfKey(k)}, the new terminal of its tab`);
    await chat.post(old.chat, `↪ This tab runs a new terminal now (${addressOfKey(k)}); it carries on here.`).catch((err) => logError(`adopt notice: ${err.message}`));
    return old;
  }

  async function ensureRoom(session, record) {
    const where = shownWhere(record);
    if (!where || !chat.ready() || !handles(session, record.address)) return null;
    const k = key(session, record.address);
    const name = roomName(where, record);
    const tab = record.labels?.['herdr.tab'] || null;
    // state.json is read again after each await: other lanes write it meanwhile
    const known = read().chats[k] || (tab ? await adoptTabRoom(k, tab) : null);
    if (known === WAIT) return null;
    if (known) {
      if (known.ended) await reviveRoom(k, known);
      if (known.name !== name || known.session !== session || (tab && known.tab !== tab)) {
        if (known.name !== name) await chat.renameRoom(known.chat, name);
        setRoom(k, { name, session, ...(tab ? { tab } : {}) });
        if (known.name !== name) log(`renamed room ${known.chat} -> ${name}`);
      }
      await chat.placeRoom(k, { space: where.space });
      return known.chat;
    }
    const room = await chat.openRoom({ name, intro: `hc terminal ${record.address} (hc session "${session}"). Type here to talk to it.` });
    const state = read();
    state.chats[k] = { chat: room, name, session, ...(tab ? { tab } : {}) };
    write(state);
    log(`created room ${name} (${room})`);
    await chat.placeRoom(k, { space: where.space });
    await backfill(session, record, k, room, name, cfg.history || { file: true, folded: true }).catch((err) => logError(`earlier conversation of ${record.address}:`, err));
    return room;
  }

  // A new room shows what came before it, so it does not open empty: the agent's whole
  // conversation so far as one file, and its newest part in one folded post, as much as
  // that holds. Only what lies before the room's cursor (the rest is posted the usual
  // way, so nothing comes twice); silent; only when a room is made, never on a restart.
  const clock = (at) => new Date(at).toISOString().replace('T', ' ').slice(0, 16);
  function transcriptOf(items) {
    const parts = [];
    for (const it of items) {
      if (it.role === 'you') parts.push(youOrOthers(it.text, ` · ${clock(it.at)}`));
      else if (it.role === 'ai') parts.push(it.text);
      else if (it.role === 'tool') parts.push(it.text);
      else if (it.role === 'image') parts.push(`_(an image ${it.from === 'you' ? 'you pasted' : 'it looked at'})_`);
    }
    return parts.join('\n\n');
  }

  // `parts`: which of {file, folded} to post (HERDR_HISTORY; /history posts both)
  async function backfill(session, record, k, room, name, parts = { file: true, folded: true }) {
    const reader = agentOf(record);
    if (!reader || (!parts.file && !parts.folded)) return;
    const until = cursorOf(k).at;
    const all = await reader.after(session, record.address, startCursor('0000-00-00T00:00:00.000Z'));
    const items = (all?.items || []).filter((it) => it.at <= until && it.role !== 'meta');
    if (!items.length) return;
    // a file both apps take (Feishu: 30 MB): the newest part when it is longer
    let whole = transcriptOf(items);
    if (Buffer.byteLength(whole) > FILE_BYTES) whole = `_(the oldest part is left out: the whole is over ${FILE_BYTES / 1e6} MB)_\n\n…${Buffer.from(whole).subarray(-FILE_BYTES).toString()}`;
    const day = clock(items[0].at).slice(0, 10);
    const file = `# ${name}\n\nhc terminal ${record.address} (hc session "${session}"), ${clock(items[0].at)} to ${clock(items[items.length - 1].at)} UTC, ${items.length} items.\n\n${whole}\n`;
    if (parts.file) await chat.postFile(room, { name: `${name.replace(/[^\p{L}\p{N}._-]+/gu, '-')}-${day}.md`, data: Buffer.from(file), caption: `The conversation before this room: ${items.length} items` });
    // the newest items that fit, whole items only, oldest of them first
    const recent = [];
    let bytes = 0;
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const size = Buffer.byteLength(transcriptOf([items[i]])) + 2;
      if (bytes + size > chat.foldedBytes) break;
      recent.unshift(items[i]);
      bytes += size;
    }
    if (parts.folded && recent.length) await chat.postFolded(room, { title: `📜 Before this room${recent.length < items.length ? ` (the last ${recent.length} of ${items.length}${parts.file ? '; all of it is in the file' : ''})` : ''}`, markdown: transcriptOf(recent) });
    log(`<- ${session}/${record.address}: earlier conversation, ${items.length} items (${recent.length} shown)`);
  }

  // A terminal that is gone keeps its room, with its history, marked ended, so a new
  // terminal in the same place gets a room that is not mistaken for the old one.
  async function endRoom(k, { again = false } = {}) {
    const known = read().chats[k];
    if (!known || (known.ended && !again)) return;
    setRoom(k, { ended: true });
    if (!again) log(`ended room ${known.name} (${known.chat})`);
    await chat.endRoom(k);
  }

  async function reviveRoom(k, known) {
    setRoom(k, { ended: false });
    await chat.reviveRoom(k);
    log(`room ${known.name} (${known.chat}) is live again`);
  }

  // Rooms of terminals that ended while the bot was down get no end event: once every
  // session's first snapshot is in, a room whose terminal is live in no session is ended.
  // A terminal on another machine counts as gone only while that machine is connected,
  // so a dropped connection never ends a room.
  async function endGone() {
    const connected = new Set();
    for (const session of cfg.sessions) {
      for (const m of await hc.machines(session).catch(() => [])) if (m.state === 'connected') connected.add(m.name);
    }
    const alive = new Set(); // every live terminal, by what it is, by address when that is unknown
    for (const session of cfg.sessions) {
      for (const record of views.get(session)?.terminals.values() || []) {
        if (record.state === 'live') alive.add(topology.identity(session, record.address) || record.address);
      }
    }
    for (const [k, c] of Object.entries(read().chats)) {
      const address = addressOfKey(k);
      const machine = machineOf(address);
      if (c.ended || !cfg.sessions.includes(c.session) || (machine && !connected.has(machine))) continue;
      if (alive.has(topology.identity(c.session, address) || address)) continue;
      laneOf(k, 'end', () => endRoom(k));
    }
  }

  // ---------- posting ----------

  // A post is retried; when it still fails, the caller keeps its cursor, so the same
  // content goes out with the next post: a repeat is acceptable, a loss is not.
  async function deliver(session, record, send) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        const room = await ensureRoom(session, record);
        return room ? await send(room) : null;
      } catch (err) {
        if (attempt >= POST_TRIES) throw err;
        logWarn(`post to ${session}/${record.address} failed (${err.message}); retry ${attempt}/${POST_TRIES - 1}`);
        await sleep(1000 * 2 ** attempt);
      }
    }
  }
  const postTo = (session, record, text, footer) => deliver(session, record, (room) => chat.post(room, text, { footer }));

  // Under each post: where it came from, as herdrchat knows it (never as the agent says):
  // the harness hc names, the model its own records name (or "screen" when it was read off
  // the screen), the git branch of the folder it runs in, how full its context is, and the
  // account's limits (lib/core/meter.mjs). What is not known is left out.
  const META = ['model', 'provider', 'context', 'limits'];
  // what the newest items say, over what the cursor kept
  function metaOf(items, cursor) {
    const meta = { ...(cursor.meta || (cursor.model ? { model: cursor.model } : {})) };
    for (const it of items) for (const f of META) if (it[f] !== undefined) meta[f] = it[f];
    return meta;
  }
  const BRANCH_MS = 15 * 1000;
  const branches = new Map(); // key -> {branch, at}
  async function branchNow(session, record) {
    const k = key(session, record.address);
    const was = branches.get(k);
    if (was && Date.now() - was.at < BRANCH_MS) return was.branch;
    const branch = await branchOf((script) => shell(session, machineOf(record.address), script), record.foreground?.cwd || record.cwd).catch(() => '');
    branches.set(k, { branch, at: Date.now() });
    return branch;
  }
  async function footerFor(session, record, app, meta = {}, { screen = false } = {}) {
    const reader = readerFor(app);
    const [branch, more] = await Promise.all([branchNow(session, record), reader?.meter ? Promise.resolve(reader.meter(session, record.address, meta)).catch(() => ({})) : {}]);
    const context = meta.context ? { used: meta.context.used, size: meta.context.size || more?.contextSize } : undefined;
    return footerWords({ app: reader?.short || app, model: meta.model, screen, branch, context, limits: meta.limits || more?.limits });
  }
  const screenFooter = (session, record) => footerFor(session, record, record.status?.app || record.foreground?.name, {}, { screen: true });
  const agentFooter = (session, record, reader) => footerFor(session, record, reader.app, metaOf([], cursorOf(key(session, record.address))));

  async function screen(session, address, lines = SCREEN_LINES) {
    return `\`\`\`\n${tidyScreen(await hc.screenTail(session, address, lines)) || '(blank)'}\n\`\`\``;
  }

  // Per terminal, in state.json: the cursor of what its reader posted, which reader and
  // which log that was (kept after the program exits, to post what it left).
  const cursorOf = (k) => read().cursors?.[k] || { ...startCursor(startedAt), reader: null, file: null };
  function saveCursor(k, cursor) {
    const state = read();
    state.cursors = { ...(state.cursors || {}), [k]: cursor };
    write(state);
  }

  // What you sent from the chat; its room shows it already, so it is not posted again.
  const fromChat = new Map();

  // A message another terminal sent with `hc send` reaches the agent wrapped by hc as
  // <hc from="t7 review" reach="...">...</hc> (any agent: hc adds it), so it is shown as
  // from that terminal, not as yours; what is around such notes is yours.
  const HC_NOTE = /<hc from="([^"]*)"(?:\s+reach="([^"]*)")?>([\s\S]*?)<\/hc>/g;
  const quoted = (text) => text.split('\n').map((l) => `> ${l}`).join('\n');
  function youOrOthers(text, at = '') {
    const parts = [];
    let rest = text;
    for (const m of text.matchAll(HC_NOTE)) {
      parts.push(`**From ${m[1]}**${at}${m[2] ? ` _(answer: ${m[2]})_` : ''}\n${quoted(m[3].trim())}`);
      rest = rest.replace(m[0], '');
    }
    rest = rest.trim();
    if (rest) parts.unshift(`**You:**${at ? ` ${at.replace(/^ · /, '')}` : ''}\n${quoted(rest)}`);
    return parts.join('\n\n');
  }

  function formatItems(k, items) {
    const sent = fromChat.get(k) || [];
    const parts = [];
    for (const it of items) {
      if (it.role === 'tool') {
        const last = parts[parts.length - 1];
        if (last?.startsWith('▸ ')) parts[parts.length - 1] = `${last}\n${it.text}`;
        else parts.push(it.text);
        continue;
      }
      if (it.role === 'image') {
        // uploaded by uploadImages. One you send from the room reaches the terminal as a
        // file path, so it comes back as your text, not as an image.
        const shown = it.key || `_(an image ${it.from === 'you' ? 'you pasted' : 'it looked at'} was not sent: ${it.error})_`;
        parts.push(`${it.from === 'you' ? '**You:**\n' : ''}${shown}`);
        continue;
      }
      if (it.role === 'you') {
        const i = sent.indexOf(it.text);
        if (i >= 0) {
          sent.splice(i, 1);
          continue;
        }
        parts.push(youOrOthers(it.text));
      } else {
        parts.push(it.text);
      }
    }
    return parts.join('\n\n');
  }

  // While it works, a turn has one live card: a single message, edited in place as the
  // agent goes on, so the room shows it is alive without a new message (and a ringing
  // phone) every few seconds. The turn's last answer then comes as a new message. A full
  // card is closed and the next one goes on; a card that cannot be edited is sent again
  // as a new one (a repeat, never a loss). It is kept in the cursor (`live: {message,
  // text}`), so a restart goes on editing it.
  async function newLive(session, record, text, footer) {
    const parts = chat.split(text);
    let message = null;
    for (const [i, part] of parts.entries()) {
      const last = i === parts.length - 1;
      message = await deliver(session, record, (room) => chat.postCard(room, { title: last ? LIVE_TITLE : FULL_TITLE, tone: last ? 'working' : 'closed', markdown: part, footer }));
    }
    return message ? { message, text: parts[parts.length - 1], footer } : null;
  }

  async function addLive(session, record, live, add, footer) {
    if (!live) return newLive(session, record, add, footer);
    const text = `${live.text}\n\n${add}`;
    if (Buffer.byteLength(text) > chat.liveBytes) {
      await closeLive(live, FULL_TITLE);
      return newLive(session, record, add, footer);
    }
    try {
      await chat.editCard(live.message, { title: LIVE_TITLE, tone: 'working', markdown: text, footer });
      return { message: live.message, text, footer };
    } catch (err) {
      logError(`live card ${live.message} not editable (${err.message}); sending it again`);
      return newLive(session, record, text, footer);
    }
  }

  async function closeLive(live, title = CLOSED_TITLE) {
    try {
      await chat.editCard(live.message, { title, tone: 'closed', markdown: live.text, footer: live.footer });
    } catch (err) {
      logError(`live card ${live.message} not closed (${err.message})`); // its text is all there
    }
  }

  // Images go to the chat first: each once (by item id), so a post retried after a
  // failure does not upload it again. After UPLOAD_TRIES posts that failed on the same
  // image, the room gets a line saying it was not sent and why, so one image cannot hold
  // back everything after it.
  const uploaded = new Map();
  const uploadFailures = new Map();
  async function uploadImages(items) {
    for (const it of items) {
      if (it.role !== 'image' || it.key || it.error) continue;
      if (!uploaded.has(it.id)) {
        try {
          uploaded.set(it.id, await chat.image(Buffer.from(it.data, 'base64')));
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
  // last answer, which is left for the turn's end (not consumed, so nothing is lost).
  // Otherwise: what came before the last answer goes into the live card, which is closed,
  // and the answer onward is a new message; with no live card, everything is one message.
  async function postItems(session, record, k, cursor, items, reader, file, { live = false } = {}) {
    const answerAt = items.findIndex((it) => it.end);
    const take = live && answerAt >= 0 ? items.slice(0, answerAt) : items;
    if (!take.length && !(cursor.live && !live)) return;
    await uploadImages(take);
    // the newest model named so far; an item that only names it (role "model") is not shown
    // what the items say for the footer; an item that only says that (role "meta") is not shown
    const meta = metaOf(take, cursor);
    const footer = await footerFor(session, record, reader.app, meta);
    const shown = take.filter((it) => it.role !== 'meta');
    let open = cursor.live || null;
    const shownAt = shown.findIndex((it) => it.end);
    const head = live ? shown : shownAt >= 0 ? shown.slice(0, shownAt) : open ? shown : [];
    const tail = live ? [] : shown.slice(head.length);
    const headText = formatItems(k, head);
    if (headText) open = await addLive(session, record, open, headText, footer);
    if (!live && open) {
      await closeLive({ ...open, footer }); // the model may be named only now
      open = null;
    }
    const tailText = formatItems(k, tail);
    if (tailText) await chat.ring(k, await postTo(session, record, tailText, footer), '✅ done');
    const last = shown[shown.length - 1];
    saveCursor(k, { ...advance(cursor, take), reader: reader.app, file, meta, ended: last ? last.role === 'ai' && Boolean(last.end) : cursor.ended, live: open });
    if (take.length) log(`<- ${session}/${record.address}: ${take.length} items (${reader.app}${live ? ', live card' : ''})`);
  }

  // Posts what a terminal said since the last post, through its reader. With
  // `waitForEnd`, it first waits for the turn's last answer (hc reports the end before
  // the agent writes it). Returns false when the terminal is not readable.
  async function postRead(session, address, record, reader, { waitForEnd, live = false }) {
    const k = key(session, address);
    const cursor = cursorOf(k);
    let found = null;
    for (let attempt = 0; attempt < (waitForEnd ? END_TRIES : 1); attempt += 1) {
      found = await reader.after(session, address, cursor);
      if (!found || found.items.some((it) => it.end)) break;
      if (!found.items.length && cursor.ended) break; // the live posts already reached the turn's end
      await sleep(END_WAIT_MS);
    }
    if (!found) return false;
    await postItems(session, record, k, cursor, found.items, reader, found.file, { live });
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
    await chat.ring(key(session, address), await postTo(session, record, await screen(session, address, TURN_SCREEN_LINES), await screenFooter(session, record)), '✅ done');
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
    await endRoom(k);
    // a new terminal that came up in the same tab while this one still ran takes the room now
    const tab = read().chats[k]?.tab;
    const next = tab && [...(views.get(session)?.terminals.values() || [])].find((t) => t.state === 'live' && t.address !== address && t.labels?.['herdr.tab'] === tab);
    if (next) later(session, next.address, 'room', () => ensureRoom(session, next));
  }

  // ---------- dialogs: it waits for you ----------

  // What each dialog card showed, by message, so an answered card keeps it.
  const dialogCards = new Map();
  function remember(message, shown) {
    dialogCards.set(message, shown);
    if (dialogCards.size > 200) dialogCards.delete(dialogCards.keys().next().value);
  }

  // With a menu, the card shows only the dialog, as plain text that wraps on a phone;
  // without one, the last lines of the screen, where a dialog sits.
  const escapeMarkdown = (text) => text.replace(/[\\`*_[\]#>~|]/g, '\\$&');
  function dialogOf(status, screenText, footer) {
    const menu = menuOf(screenText);
    const title = `${NEEDS_TITLE}${status?.kind ? ` (${status.kind})` : ''}`;
    const markdown = menu ? escapeMarkdown(menu.text) : `\`\`\`\n${tidyScreen(screenText, DIALOG_LINES)}\n\`\`\``;
    return { menu, title, markdown, doneTitle: DONE_TITLE, footer };
  }
  // A dialog the agent itself names through its own API (its reader's `dialog`), in the
  // shape a screen's dialog has; `menu.own` is the agent's, for its reader's `answer`.
  function agentDialog(d, status, footer) {
    const options = d.options.map(({ n, label, checked }) => ({ n, label, checked: checked ?? null }));
    const free = d.free ? options.find((o) => o.n === d.free.n) || null : null;
    const menu = { key: d.key, options, multi: Boolean(d.multi), free, text: d.text || '', framed: true, beside: false, cursor: 1, own: d };
    return { menu, title: `${NEEDS_TITLE} (${d.kind || status?.kind || 'question'})`, markdown: escapeMarkdown(d.text || ''), doneTitle: DONE_TITLE, footer };
  }
  // What a terminal asks now: from the agent's own API when its reader has one, which an
  // update of the agent's screen cannot break; else read off its screen.
  async function askedNow(session, address, record, status) {
    const reader = agentOf(record);
    if (reader?.dialog) {
      const d = await reader.dialog(session, address).catch((err) => logWarn(`${session}/${address}: ${reader.app} dialog not read (${err.message})`));
      if (d) return agentDialog(d, status, await agentFooter(session, record, reader));
    }
    return dialogOf(status, await hc.screenTail(session, address, SCREEN_LINES), await screenFooter(session, record));
  }

  // c: the terminal's width when the card was made, to tell a resize from a new dialog
  const dialogValue = (session, address, dialog, cols) => ({ s: session, a: address, k: dialog.menu.key, ...(cols ? { c: cols } : {}) });

  // One dialog gets one card. A dialog is named by its menu key (or, with no menu, by its
  // status words); the name is claimed before anything is sent, so the turn event, a
  // status event and a click that all see the same dialog post it once. Leaving `blocked`
  // forgets it, so the same dialog asked again later gets a card again.
  const postedDialog = new Map(); // terminal key -> name of the dialog last posted
  const dialogName = (dialog, status) => (dialog.menu ? dialog.menu.key : `${status?.kind || ''}|${status?.msg || ''}`);
  function claimDialog(k, dialog, status) {
    const name = dialogName(dialog, status);
    if (postedDialog.get(k) === name) return false;
    postedDialog.set(k, name);
    return true;
  }

  // The dialog card still waiting, per terminal. When its dialog goes away, the card drops
  // its buttons and says so, so the room never shows a question nobody waits on. Kept in
  // state.json (openCards) too: after a restart the card out is known, so it is neither
  // posted again nor left without what its buttons mean.
  const openCard = (() => {
    const mem = new Map(Object.entries(read().openCards || {}));
    const save = () => {
      const state = read();
      state.openCards = Object.fromEntries(mem);
      write(state);
    };
    return {
      get: (k) => mem.get(k),
      has: (k) => mem.has(k),
      set: (k, { message, dialog }) => { mem.set(k, { message, dialog }); save(); },
      delete: (k) => { const had = mem.delete(k); if (had) save(); return had; },
      entries: () => [...mem.entries()],
    };
  })();
  for (const [k, { message, dialog }] of openCard.entries()) {
    remember(message, dialog);
    postedDialog.set(k, dialogName(dialog, {}));
  }
  async function closeCard(k, done) {
    const open = openCard.get(k);
    if (!open) return;
    openCard.delete(k);
    try {
      await chat.closeDialog(open.message, open.dialog, done);
    } catch (err) {
      logError(`dialog card ${open.message} not closed (${err.message})`);
    }
  }

  // `screen`: the screen read when the event came (a promise), so a dialog answered in
  // the terminal while earlier work was still being posted still gets its card. `again`:
  // post it even if it was posted (you typed in the room while it waits). A screen read
  // the moment `blocked` arrives may come before the dialog is drawn, and then a numbered
  // list the agent wrote looks like a menu: a dialog is believed once it has its top
  // border and two reads DRAW_WAIT_MS apart show the same one, or after DRAW_TRIES reads.
  // `own`: only what the agent itself names (its hook just asked); nothing from the screen.
  async function postBlocked(session, address, record, { screen: first = null, again = false, own = false } = {}) {
    let dialog = null;
    const reader = agentOf(record);
    if (reader?.dialog) {
      // the agent names it itself: asked again a moment later while it has not yet, unless
      // it cannot tell here (false: no hook on that machine)
      for (let i = 0; i < DRAW_TRIES; i += 1) {
        const d = await reader.dialog(session, address).catch((err) => logWarn(`${session}/${address}: ${reader.app} dialog not read (${err.message})`));
        if (d) {
          dialog = agentDialog(d, record.status, await agentFooter(session, record, reader));
          break;
        }
        if (d === false) break;
        await sleep(DRAW_WAIT_MS);
      }
    }
    if (!dialog && own) return;
    if (!dialog) {
      const firstScreen = await first;
      const footer = await screenFooter(session, record);
      dialog = firstScreen ? dialogOf(record.status, firstScreen, footer) : null;
      for (let i = 0; i < DRAW_TRIES; i += 1) {
        if (dialog || i) await sleep(DRAW_WAIT_MS);
        const next = dialogOf(record.status, await hc.screenTail(session, address, SCREEN_LINES), footer);
        const steady = dialog?.menu?.framed && next.menu?.key === dialog.menu.key;
        dialog = next;
        if (steady) break;
      }
    }
    const k = key(session, address);
    // answered while its screen was being read: nothing waits, so no card (what the agent
    // names itself waits until answered, whatever its status says: Codex works on while
    // its hook asks)
    const nowStatus = (await hc.getTerminal(session, address).catch(() => null))?.status;
    if (!dialog.menu?.own && nowStatus && nowStatus.state !== 'blocked') {
      log(`<- ${session}/${address}: no card, it no longer waits (${nowStatus.state})`);
      return;
    }
    if (!claimDialog(k, dialog, record.status) && !again) return;
    try {
      await sendBlocked(session, address, record, k, dialog);
    } catch (err) {
      // not posted: let the next event (or a held message) post it, never "posted already"
      if (postedDialog.get(k) === dialogName(dialog, record.status)) postedDialog.delete(k);
      throw err;
    }
    log(`<- ${session}/${address}: blocked${dialog.menu ? ` (${dialog.menu.options.length} options)` : ''}`);
  }
  // Whether the terminal still waits on what `dialog` asks: blocked; or its hook still
  // asks (Codex works on meanwhile); or, for a question that leaves the agent idle
  // (`idle`: Codex's async ones, answered by your next message), it does not work.
  function stillAsks(record, dialog) {
    if (record?.status?.state === 'blocked') return true;
    const own = dialog?.menu?.own;
    if (own && askOf(record)) return true;
    return Boolean(own?.idle && record?.status?.state && record.status.state !== 'working');
  }
  // A question the agent asked that leaves it idle (its reader's dialog, `idle`): its card
  // goes once its turn has been posted, and at a sweep when it has none.
  async function postIdleAsk(session, address, record) {
    const reader = agentOf(record);
    if (!reader?.dialog) return;
    const d = await reader.dialog(session, address).catch((err) => logWarn(`${session}/${address}: ${reader.app} dialog not read (${err.message})`));
    if (!d?.idle) return;
    const k = key(session, address);
    const dialog = agentDialog(d, record.status, await agentFooter(session, record, reader));
    if (!claimDialog(k, dialog, record.status)) return;
    try {
      await sendBlocked(session, address, record, k, dialog);
    } catch (err) {
      if (postedDialog.get(k) === dialogName(dialog, record.status)) postedDialog.delete(k);
      throw err;
    }
    log(`<- ${session}/${address}: asks (${dialog.menu.options.length} options; it waits idle)`);
  }
  async function sendBlocked(session, address, record, k, dialog) {
    await closeCard(k, 'It moved on; see the next card.');
    if (!dialog.menu) {
      const sent = await postTo(session, record, `**${dialog.title}**\n\n${dialog.markdown}\n\nReply \`/answer <text>\` to answer it, or \`/esc\` to cancel it.`, dialog.footer);
      const room = read().chats[k]?.chat;
      if (room) await chat.pin(k, room, sent);
      await chat.ring(k, sent, '⚠️ needs you');
    } else {
      const message = await deliver(session, record, (room) => chat.postDialog(room, dialog, dialogValue(session, address, dialog, record.cols)));
      if (message) {
        remember(message, dialog);
        openCard.set(k, { message, dialog });
        const room = read().chats[k]?.chat;
        if (room) await chat.pin(k, room, message);
        await chat.ring(k, message, '⚠️ needs you');
        // answered while the card was on its way: nothing will close it later, so now
        const live = views.get(session)?.terminals.get(address);
        if (!stillAsks(live, dialog) || postedDialog.get(k) !== dialogName(dialog, record.status)) await closeCard(k, '✔ Answered.');
      } else {
        throw new Error('the room for its card is gone');
      }
    }
  }

  // The keys that pick an option: its digit, or, in a question with previews (which takes
  // no digit), the arrows from the cursor to it and Enter.
  function pickKeys(menu, option) {
    if (!menu.beside) return [String(option.n)];
    const moves = option.n - (menu.cursor || 1);
    return [...Array(Math.abs(moves)).fill(moves > 0 ? 'down' : 'up'), 'enter'];
  }

  // "Type something": pick that option, then type the words.
  async function answerFree(session, address, menu, text) {
    await hc.keys(session, address, pickKeys(menu, menu.free));
    await sleep(300);
    await hc.send(session, address, text, { force: true });
  }

  const toast = (type, text) => ({ toast: { type, text } });
  const answered = (shown, done) => ({ ...toast('info', done), card: { kind: 'done', dialog: shown, done } });

  // A click on a dialog card. The screen is read again first, and nothing is pressed
  // unless it still shows the dialog the card was made from (same key) with the same
  // option. After the key, the card turns into the dialog's next step (the next question,
  // the review, a toggled box) or says what was picked.
  async function onAction({ value: v = {}, message, answer = '', ticks = null }) {
    const started = Date.now();
    const shown = dialogCards.get(message) || { title: NEEDS_TITLE, markdown: '', doneTitle: DONE_TITLE };
    // A box in a multi-select is ticked on the card only, at once; Next sends them all.
    const box = shown.menu?.multi && typeof v.pick === 'number' ? shown.menu.options.find((o) => o.n === v.pick && o !== shown.menu.free && o.checked !== null) : null;
    if (box) {
      const menu = { ...shown.menu, options: shown.menu.options.map((o) => (o === box ? { ...o, checked: !o.checked } : o)) };
      const toggled = { ...shown, menu };
      remember(message, toggled);
      return { ...toast('info', `${box.checked ? '☐' : '☑'} ${box.label}`), card: { kind: 'dialog', dialog: toggled, value: v } };
    }
    const record = views.get(v.s)?.terminals.get(v.a);
    if (!record || record.state !== 'live') {
      log(`-> ${v.s}/${v.a}: click on ${message} not pressed: the terminal has ended`);
      return answered(shown, 'The terminal has ended.');
    }
    const term = await hc.getTerminal(v.s, v.a);
    const status = term.status;
    const k = key(v.s, v.a);
    if (shown.menu?.own || (!shown.menu && agentOf(record)?.dialog)) return answerOwn({ v, message, answer, ticks, shown, record, term, status, k });
    const menu = status?.state === 'blocked' ? menuOf(await hc.screenTail(v.s, v.a, SCREEN_LINES)) : null;
    if (!menu || menu.key !== v.k) {
      log(`-> ${v.s}/${v.a}: click on ${message} not pressed: ${menu ? `the dialog changed (card ${v.k}, screen ${menu.key}; width then ${v.c || '?'}, now ${term.cols || '?'})` : `nothing waits (status ${status?.state || 'none'})`}`);
      if (!menu) return answered(shown, 'It no longer waits on this.');
      // The card in your hand becomes what the screen asks now, to tap again. Never "see the
      // new card": a new card can be held back as already posted, and then nothing is left
      // to answer while your messages wait on the dialog.
      const now = dialogOf(status, await hc.screenTail(v.s, v.a, SCREEN_LINES), shown.footer);
      if (!now.menu) return answered(shown, 'It no longer waits on this.');
      if (openCard.get(k) && openCard.get(k).message !== message) await closeCard(k, 'It moved on; see the next card.');
      postedDialog.set(k, dialogName(now, status));
      remember(message, now);
      openCard.set(k, { message, dialog: now });
      return { ...toast('warning', 'It changed before your tap, so nothing was pressed. The card shows it now: tap again.'), card: { kind: 'dialog', dialog: now, value: dialogValue(v.s, v.a, now, term.cols) } };
    }
    if (openCard.get(k)?.message === message) openCard.delete(k);
    let picked;
    if (v.pick === 'tab' && shown.menu?.multi) {
      // the boxes as ticked on the card (sent with Next by a form, or kept per tap), made
      // so on the screen: each one that differs is pressed
      const wanted = ticks ? { ...shown.menu, options: shown.menu.options.map((o) => (o.checked === null ? o : { ...o, checked: Boolean(ticks[o.n]) })) } : shown.menu;
      const changed = wanted.options.filter((o) => o.checked !== null && o.checked !== menu.options.find((m) => m.n === o.n)?.checked);
      for (const o of changed) {
        await hc.keys(v.s, v.a, [String(o.n)]);
        await sleep(BOX_GAP_MS);
      }
      await hc.keys(v.s, v.a, ['tab']);
      const ticked = wanted.options.filter((o) => o.checked).map((o) => o.label);
      picked = ticked.length ? ticked.join(', ') : 'nothing ticked';
    } else if (v.pick === 'esc' || v.pick === 'tab') {
      await hc.keys(v.s, v.a, [v.pick]);
      picked = v.pick === 'esc' ? 'Esc pressed' : 'Next';
    } else {
      const option = menu.options.find((o) => o.n === v.pick);
      if (!option || option.label !== v.label) {
        log(`-> ${v.s}/${v.a}: click on ${message} not pressed: option ${v.pick} is now ${option ? `"${option.label}"` : 'gone'}, not "${v.label}"`);
        return answered(shown, 'The options changed; nothing was pressed.');
      }
      if (option === menu.free) {
        const text = answer.trim();
        if (!text) return toast('warning', 'Type your answer first.');
        await answerFree(v.s, v.a, menu, text);
        picked = text;
      } else {
        await hc.keys(v.s, v.a, pickKeys(menu, option));
        picked = `${option.n}. ${option.label}`;
      }
    }
    log(`-> ${v.s}/${v.a}: picked ${picked}`);

    // A slow machine: answer the click now, show the next step as a new card after.
    if (Date.now() - started > CLICK_BUDGET_MS) {
      later(v.s, v.a, 'dialog', async () => {
        await sleep(KEY_SETTLE_MS);
        const next = (await hc.getTerminal(v.s, v.a)).status;
        if (next?.state === 'blocked') await postBlocked(v.s, v.a, { ...record, status: next });
      });
      return answered(shown, `✔ ${picked}`);
    }
    await sleep(KEY_SETTLE_MS);
    const nextStatus = (await hc.getTerminal(v.s, v.a)).status;
    if (nextStatus?.state === 'blocked') {
      const next = dialogOf(nextStatus, await hc.screenTail(v.s, v.a, SCREEN_LINES), shown.footer);
      // the same dialog (a toggled box) is redrawn here; a new one only if no card has it yet
      if (next.menu && (next.menu.key === v.k || claimDialog(k, next, nextStatus))) {
        remember(message, next);
        openCard.set(k, { message, dialog: next });
        return { ...toast('info', `✔ ${picked}`), card: { kind: 'dialog', dialog: next, value: dialogValue(v.s, v.a, next, term.cols) } };
      }
      // its card is out already, unless that card was closed: then this one shows it
      if (next.menu && openCard.has(k)) return answered(shown, `✔ ${picked}`);
      if (next.menu) {
        postedDialog.set(k, dialogName(next, nextStatus));
        remember(message, next);
        openCard.set(k, { message, dialog: next });
        return { ...toast('info', `✔ ${picked}`), card: { kind: 'dialog', dialog: next, value: dialogValue(v.s, v.a, next, term.cols) } };
      }
      // still waiting, on something with no menu: hc sends no new turn for it, so post it
      later(v.s, v.a, 'dialog', () => postBlocked(v.s, v.a, { ...record, status: nextStatus }));
    }
    return answered(shown, `✔ ${picked}`);
  }

  // A click on a card the agent's own API made: answered through that API, after asking it
  // what it waits on now; nothing is typed into the terminal.
  async function answerOwn({ v, message, answer, ticks, shown, record, term, status, k }) {
    const reader = agentOf(record);
    const now = reader?.dialog ? (await reader.dialog(v.s, v.a).catch(() => null)) || null : null;
    if (!now) {
      log(`-> ${v.s}/${v.a}: click on ${message} not answered: nothing waits (status ${status?.state || 'none'})`);
      return answered(shown, 'It no longer waits on this.');
    }
    const asked = agentDialog(now, status, shown.footer);
    if (now.key !== v.k) {
      log(`-> ${v.s}/${v.a}: click on ${message} not answered: it asks something else now (${now.key})`);
      if (openCard.get(k) && openCard.get(k).message !== message) await closeCard(k, 'It moved on; see the next card.');
      postedDialog.set(k, dialogName(asked, status));
      remember(message, asked);
      openCard.set(k, { message, dialog: asked });
      return { ...toast('warning', 'It asks something else now, so nothing was answered. The card shows it: tap again.'), card: { kind: 'dialog', dialog: asked, value: dialogValue(v.s, v.a, asked, term.cols) } };
    }
    let picked;
    let reply;
    if (v.pick === 'esc') {
      reply = { esc: true };
      picked = 'Cancelled';
    } else if (v.pick === 'tab' && asked.menu.multi) {
      const boxes = shown.menu?.multi ? shown.menu.options : asked.menu.options;
      const ticked = ticks || Object.fromEntries(boxes.filter((o) => o.checked !== null).map((o) => [o.n, o.checked]));
      reply = { ticks: ticked };
      picked = boxes.filter((o) => ticked[o.n]).map((o) => o.label).join(', ') || 'nothing ticked';
    } else {
      const option = now.options.find((o) => o.n === v.pick);
      if (!option || option.label !== v.label) return answered(shown, 'The options changed; nothing was answered.');
      if (now.free && option.n === now.free.n) {
        const text = answer.trim();
        if (!text) return toast('warning', 'Type your answer first.');
        reply = { pick: option.n, text };
        picked = text;
      } else {
        reply = { pick: option.n };
        picked = `${option.n}. ${option.label}`;
      }
    }
    if (!(await reader.answer(v.s, v.a, now, reply).catch(() => false))) {
      logWarn(`-> ${v.s}/${v.a}: ${reader.app} did not take the answer to ${now.key}`);
      return toast('error', `${reader.app} did not take it; nothing changed. Tap again, or answer in herdr-app.`);
    }
    if (openCard.get(k)?.message === message) openCard.delete(k);
    log(`-> ${v.s}/${v.a}: answered ${picked} (through ${reader.app})`);
    await sleep(KEY_SETTLE_MS);
    // its next question (of the same form, or a new one) takes this card's place
    const next = await reader.dialog(v.s, v.a).catch(() => null);
    if (next && next.key !== now.key) {
      const nd = agentDialog(next, status, shown.footer);
      postedDialog.set(k, dialogName(nd, status));
      remember(message, nd);
      openCard.set(k, { message, dialog: nd });
      return { ...toast('info', `✔ ${picked}`), card: { kind: 'dialog', dialog: nd, value: dialogValue(v.s, v.a, nd, term.cols) } };
    }
    return answered(shown, `✔ ${picked}`);
  }

  // ---------- following hc ----------

  // Shown terminals this session runs whose program is a running agent, with its reader.
  function readable(session) {
    return [...(views.get(session)?.terminals.values() || [])]
      .filter((record) => shownWhere(record) && handles(session, record.address) && reachable(session, record.address))
      .map((record) => ({ record, reader: agentOf(record) }))
      .filter((x) => x.reader);
  }

  // A missed turn event (bot down, event stream reconnected) or a turn posted before its
  // last answer was written would leave content behind; idle readable terminals are
  // checked again at start, after every snapshot and every SWEEP_MS.
  function sweep(session) {
    for (const { record, reader } of readable(session)) {
      // one that waits with no card (it waited before the bot started, or its event was
      // missed) gets it now; a card out already is not posted twice
      if (record.status?.state === 'blocked' && !openCard.has(key(session, record.address))) {
        later(session, record.address, 'dialog', () => postBlocked(session, record.address, record));
        continue;
      }
      if (askOf(record)) {
        if (!openCard.has(key(session, record.address))) later(session, record.address, 'dialog', () => postBlocked(session, record.address, record, { own: true }));
        continue;
      }
      if (['working', 'blocked'].includes(record.status?.state)) continue;
      later(session, record.address, 'sweep', async () => {
        await postRead(session, record.address, record, reader, { waitForEnd: false });
        await markDone(key(session, record.address), { olderThan: SWEEP_DONE_MS }); // a turn end that was missed
        if (!reader.asksIdle) return;
        const k = key(session, record.address);
        const open = openCard.get(k)?.dialog?.menu?.own;
        if (!openCard.has(k)) await postIdleAsk(session, record.address, record);
        else if (open?.idle) {
          // answered while the bot was down (in the terminal): its card closes
          const now = await reader.dialog(session, record.address).catch(() => open);
          if (now?.key !== open.key) await closeCard(k, '✔ Answered.');
        }
      });
    }
  }

  // While a readable terminal works, what it says and does is posted every LIVE_MS; the
  // turn's end then posts the rest. One check per terminal at a time.
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
  // one dialog straight to the next never works in between, so the status events catch
  // that: blocked, and not coming from working (that case is the turn event's, which
  // posts what it said first).
  const lastState = new Map(); // terminal key -> status state at the last status event
  const since = new Map(); // terminal key -> when its status state last changed

  function onStatus(session, address, record) {
    const k = key(session, address);
    const was = lastState.get(k);
    const now = record.status?.state;
    lastState.set(k, now);
    if (now !== was) since.set(k, Date.now());
    if (now !== 'blocked') {
      // its hook still asks (Codex works on meanwhile): the card stays, and so do messages
      if (askOf(record) && openCard.get(k)?.dialog?.menu?.own) return;
      // a question that leaves it idle waits on your next message: its card stays till then
      if (openCard.get(k)?.dialog?.menu?.own?.idle && now !== 'working') return;
      postedDialog.delete(k);
      if (now && !askOf(record)) sendWaiting(k);
      if (chat.pinned().includes(k)) later(session, address, 'unpin', () => chat.unpin(k));
      if (openCard.has(k)) later(session, address, 'dialog', () => closeCard(k, '✔ Answered.'));
      return;
    }
    if (was === 'working' || !shownWhere(record) || !handles(session, address) || !agentOf(record)) return;
    // the screen and the status as they are now: by the time the lane gets to it, the
    // dialog may be answered and the status moved on
    const screenNow = hc.screenTail(session, address, SCREEN_LINES).catch(() => null);
    const status = { ...record.status };
    later(session, address, 'dialog', () => postBlocked(session, address, { ...record, status }, { screen: screenNow }));
  }

  // The agent's hook asks (its terminal's herdrchat.ask label, ../asks.mjs): its card goes
  // at once, whatever the status (Codex shows no prompt and works on while it waits).
  // The label going means the hook is done: answered here, in the terminal, or its time
  // ran out; its card closes, and what the terminal still asks is read off its screen.
  const lastAsk = new Map(); // terminal key -> the label's request id
  function onAsk(session, address, record) {
    const k = key(session, address);
    const id = askOf(record);
    const was = lastAsk.get(k) || '';
    if (id === was) return;
    lastAsk.set(k, id);
    if (!shownWhere(record) || !handles(session, address) || !agentOf(record)) return;
    if (id) {
      later(session, address, 'dialog', () => postBlocked(session, address, record, { own: true }));
      return;
    }
    later(session, address, 'dialog', async () => {
      if (openCard.get(k)?.dialog?.menu?.own) await closeCard(k, '✔ Answered.');
      // only the hook's dialog is forgotten: a screen dialog that got its card meanwhile
      // (Codex's own prompt, once its hook is done) keeps it, and is not posted twice
      const posted = postedDialog.get(k);
      if (was && (posted === was || posted?.startsWith(`${was}#`))) postedDialog.delete(k);
      const term = await hc.getTerminal(session, address).catch(() => null);
      if (term?.status?.state === 'blocked') await postBlocked(session, address, { ...record, status: term.status });
      else if (term?.status?.state) sendWaiting(k);
    });
  }

  // A hook that could not label its terminal (Codex through its shared background service
  // runs it outside the terminal) is found here by its reader (`strayAsk`) and its terminal
  // labelled, so it goes on as any other; a label whose hook is gone (left by a restart, or
  // set here) is taken away. Asked every ASKS_MS while a request waits on this machine or
  // a label is out, and at every sweep for connected machines too.
  const asking = new Set(); // sessions being looked at now
  async function claimAsks(session, { everywhere = false } = {}) {
    if (asking.has(session)) return;
    asking.add(session);
    try {
      for (const { record, reader } of readable(session)) {
        const machine = machineOf(record.address);
        if (machine && !everywhere) continue;
        const id = askOf(record);
        if (id) {
          if (!(await askLives(session, machine, id).catch(() => true))) {
            await hc.label(session, record.address, { [LABEL]: '' });
            log(`${session}/${record.address}: its hook is gone; label ${LABEL} taken away`);
          }
          continue;
        }
        if (!reader.strayAsk || !asksWaiting()) continue;
        const stray = await reader.strayAsk(session, record.address).catch(() => null);
        if (stray) {
          await hc.label(session, record.address, { [LABEL]: stray });
          log(`${session}/${record.address}: ${reader.app} asks through its hook from outside the terminal (${stray}); labelled`);
        }
      }
    } finally {
      asking.delete(session);
    }
  }
  const labelsOut = (session) => readable(session).some(({ record }) => askOf(record) && !machineOf(record.address));

  function watch(session) {
    const view = hc.followEvents(session, {
      log,
      onSnapshot: (list) => {
        firstSnapshot.get(session).done();
        scheduleOverview();
        for (const record of list) if (shownWhere(record)) later(session, record.address, 'room', () => ensureRoom(session, record));
        setTimeout(() => sweep(session), 0); // after views has this session's records
      },
      onChange: ({ type, address, record, data }) => {
        scheduleOverview();
        if (type === 'status' && record) onStatus(session, address, record);
        if (type === 'labels' && record) onAsk(session, address, record);
        if (['created', 'restarted', 'labels', 'status', 'title'].includes(type) && shownWhere(record)) {
          later(session, address, 'room', () => ensureRoom(session, record));
        } else if ((type === 'finished' || type === 'removed') && roomOf(session, address)?.session === session) {
          later(session, address, 'end', () => postEnd(session, address, record || { address }, data?.reason));
        }
      },
      onTurn: ({ address, state, record }) => {
        scheduleOverview();
        log(`turn ${session}/${address}: ${state}${shownWhere(record) ? '' : ' (not shown in herdr-app)'}`);
        // a room mirrors agents: a shell or another program posts nothing by itself
        if (!shownWhere(record) || !handles(session, address) || !agentOf(record)) return;
        const screenNow = state === 'blocked' ? hc.screenTail(session, address, SCREEN_LINES).catch(() => null) : null;
        const status = { ...record.status };
        later(session, address, 'turn', async () => {
          if (state === 'blocked') {
            // what it said before stopping to ask comes first
            const reader = agentOf(record);
            if (reader) await postRead(session, address, record, reader, { waitForEnd: false }).catch(() => {});
            await postBlocked(session, address, { ...record, status }, { screen: screenNow });
            return;
          }
          // ended on a question that leaves it idle: no last answer is coming, so what it
          // said goes at once, then the question's card
          const reader = agentOf(record);
          const asks = reader?.asksIdle ? await reader.dialog(session, address).catch(() => null) : null;
          if (asks?.idle) await postRead(session, address, record, reader, { waitForEnd: false }).catch((err) => logError(`${session}/${address}: ${reader.app} not readable (${err.message})`));
          else await postTurn(session, address, record);
          await markDone(key(session, address));
          if (reader?.asksIdle) await postIdleAsk(session, address, { ...record, status });
        });
      },
    });
    views.set(session, view);
  }

  // ---------- from the chat ----------

  // What you sent from a room is marked: working once it is typed into the terminal,
  // done when the turn that took it is over (the turn ends, a terminal with no agent
  // shows what the command did, or the terminal ends). Which messages wait for their
  // done mark is kept in state.json (reacts), so a restart still marks them. A failure
  // is only logged.
  async function markWorking(k, message) {
    try {
      const token = await chat.markWorking(message);
      const state = read();
      state.reacts = { ...(state.reacts || {}), [k]: [...(state.reacts?.[k] || []), { message, reaction: token, at: Date.now() }] };
      write(state);
    } catch (err) {
      logError(`reaction on ${message}: ${err.message}`);
    }
  }

  // `olderThan`: only messages typed in at least this long ago (the sweep: a message just
  // typed in may not have started a turn yet).
  async function markDone(k, { olderThan = 0 } = {}) {
    const all = read().reacts?.[k] || [];
    const waiting = all.filter((x) => Date.now() - (x.at || 0) >= olderThan);
    if (!waiting.length) return;
    const state = read();
    const left = (state.reacts?.[k] || []).filter((x) => !waiting.some((w) => w.message === x.message));
    if (left.length) state.reacts[k] = left;
    else delete state.reacts[k];
    write(state);
    for (const { message, reaction } of waiting) {
      try {
        await chat.markDone(message, reaction);
      } catch (err) {
        logError(`reaction on ${message}: ${err.message}`);
      }
    }
  }

  // Messages sent while it waited on a dialog with no box to type in, per terminal, kept
  // in state.json (waiting) so a restart does not lose them; they go in, in order, once it
  // no longer waits (onStatus, and at start).
  function hold(k, m) {
    const state = read();
    state.waiting = { ...(state.waiting || {}), [k]: [...(state.waiting?.[k] || []), m] };
    write(state);
  }
  function sendWaiting(k) {
    const state = read();
    const held = state.waiting?.[k];
    if (!held?.length) return;
    delete state.waiting[k];
    write(state);
    for (const m of held) laneOf(k, 'held message', () => typeInto(m.where, m.message, m.session, m.address, m.text));
  }

  async function typeInto(where, message, session, address, text) {
    const record = views.get(session)?.terminals.get(address);
    if (!record || record.state !== 'live') {
      await chat.reply(where, ENDED_REPLY);
      return;
    }
    const agent = agentOf(record);
    if (text === '/history') {
      const k = key(session, address);
      const c = read().chats[k];
      if (!agent || !c) await chat.reply(where, 'No agent runs here, so there is no conversation to show.');
      else await backfill(session, record, k, c.chat, c.name);
      return;
    }
    if (text === '/screen' || text === '/esc') {
      if (text === '/esc') {
        const asked = agent?.dialog ? await agent.dialog(session, address).catch(() => null) : null;
        if (asked) await agent.answer(session, address, asked, { esc: true });
        else await hc.keys(session, address, ['esc']);
        if (asked?.idle) await closeCard(key(session, address), 'Cancelled.');
      }
      await chat.reply(where, `${text === '/esc' ? 'Esc pressed.\n\n' : ''}${await screen(session, address)}`);
      return;
    }
    const answer = text.match(/^\/answer\s+([\s\S]+)$/);
    // whether it waits on a dialog now: asked of hc, since the status followed from its
    // events can be a moment behind (a dialog just answered still looks blocked)
    const term = answer || !agent ? null : await hc.getTerminal(session, address).catch(() => record);
    const waits = Boolean(term && (term.status?.state === 'blocked' || askOf(term)));
    if (waits) {
      // It waits on a dialog: words go into its "Type something" box when it has one;
      // otherwise they wait for the dialog to be answered, then go in (never dropped).
      const menu = (await askedNow(session, address, record, record.status)).menu;
      if (menu?.free) {
        if (menu.own) await agent.answer(session, address, menu.own, { pick: menu.free.n, text });
        else await answerFree(session, address, menu, text);
        log(`-> ${session}/${address}: answered ${text.slice(0, 80)}`);
        await markWorking(key(session, address), message);
      } else {
        const k = key(session, address);
        hold(k, { where, message, session, address, text });
        log(`-> ${session}/${address}: held until its dialog is answered: ${text.slice(0, 80)}`);
        // "the card above" must be there: with a menu and no open card, post it now
        const status = (await hc.getTerminal(session, address).catch(() => record))?.status;
        if (menu && !openCard.has(k)) {
          logWarn(`${session}/${address}: waits on a dialog with no open card; posting it again`);
          await postBlocked(session, address, { ...record, status }, { again: true }).catch((err) => logError(`dialog card for ${session}/${address} not posted (${err.message})`));
        }
        await chat.reply(where, openCard.has(k) || !menu ? 'It asks something first (the card above). Your message goes in once that is answered.' : 'It asks something first, in herdr-app (its card could not be posted here). Your message goes in once that is answered.');
      }
      return;
    }
    try {
      const typed = answer ? answer[1] : text;
      await hc.send(session, address, typed, { force: Boolean(answer) });
      const k = key(session, address);
      fromChat.set(k, [...(fromChat.get(k) || []).slice(-20), typed.trim()]);
      log(`-> ${session}/${address}: ${text.slice(0, 80)}`);
      await markWorking(k, message);
    } catch (err) {
      // the screen only when it helps: it waits on something you can answer from there
      const waits = /blocked/i.test(err.message);
      await chat.reply(where, `Not delivered: ${plainError(err)}${waits ? `\n\n${await screen(session, address)}\n\nIt waits on a dialog. Reply \`/answer <text>\` to answer it, or \`/esc\` to cancel it.` : ''}`);
      return;
    }
    // Anything but an agent posts nothing by itself: what you typed gets one look at its
    // screen in reply.
    if (!agent) {
      await sleep(SHELL_ECHO_MS);
      await chat.reply(where, await screen(session, address));
      await markDone(key(session, address));
    }
  }

  // Images you send to a room: saved here, sent beside the terminal (on its machine) with
  // `hc put`, and typed in as their paths, which an agent like Claude Code opens.
  function extOf(head) {
    if (head[0] === 0x89 && head.toString('latin1', 1, 4) === 'PNG') return 'png';
    if (head[0] === 0xff && head[1] === 0xd8) return 'jpg';
    if (head.toString('latin1', 0, 4) === 'GIF8') return 'gif';
    if (head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP') return 'webp';
    return 'png';
  }

  async function imagesInto(message, session, address, refs) {
    fs.mkdirSync(inbox, { recursive: true });
    const landed = [];
    for (const [i, ref] of refs.entries()) {
      const raw = path.join(inbox, `${String(message).replace(/[^\w-]/g, '_')}-${i}`);
      await chat.download(message, ref, raw);
      const file = `${raw}.${extOf(fs.readFileSync(raw).subarray(0, 12))}`;
      fs.renameSync(raw, file);
      landed.push(await hc.put(session, address, file));
      fs.unlinkSync(file); // the terminal has its own copy now
    }
    return landed;
  }

  // ---------- the overview and the direct chat ----------

  // The overview is shown again whenever a terminal changes; changes within
  // OVERVIEW_WAIT_MS make one update.
  let overviewTimer = null;
  function overviewRows() {
    const rows = [];
    for (const session of cfg.sessions) {
      for (const record of views.get(session)?.terminals.values() || []) {
        const where = shownWhere(record);
        if (!where || !handles(session, record.address)) continue;
        const k = key(session, record.address);
        rows.push({
          name: roomName(where, record),
          address: session === cfg.sessions[0] || machineOf(record.address) ? record.address : `${session} ${record.address}`,
          state: record.status?.state,
          kind: record.status?.kind,
          program: record.foreground?.name || record.agent,
          since: since.get(k),
          room: read().chats[k]?.chat,
        });
      }
    }
    return rows;
  }
  const refreshOverview = (opts) => chat.showOverview(overviewRows(), opts);
  function scheduleOverview() {
    if (overviewTimer) return;
    overviewTimer = setTimeout(() => {
      overviewTimer = null;
      refreshOverview().catch((err) => logError(`overview: ${err.message}`));
    }, quick ? 5 : OVERVIEW_WAIT_MS);
  }

  const help = () => [
    '`/ls` a new overview of every terminal (the overview also keeps itself up to date)',
    '`/new <session> <space>/<tab> [command]` start a terminal (default `claude`); `--cwd <dir>` first to pick its folder',
    '`/kill <session> <address>` end a terminal',
    ...(chat.help || []),
    `In a terminal's ${chat.roomWord}: type to talk to it; \`/screen\`, \`/answer <text>\`, \`/esc\`, \`/history\` (the conversation so far, as a file).`,
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
    const tabId = `tb${crypto.randomBytes(16).toString('hex')}`;
    const out = await hc.run(session, {
      cwd: folder,
      labels: { 'herdr.space': spaceId, 'herdr.tab': tabId, where: `${space} / ${tab}` },
      argv: ['/bin/zsh', '-lc', `exec ${line}`], // login shell for PATH; exec so no bare shell is left behind
    });
    const address = JSON.parse(out).address;
    // herdr-app makes the tab and numbers it, whatever `where` says: it is named as asked,
    // by the tab id it keeps (nothing happens where herdr-app is not running)
    if (hc.nameTab) hc.nameTab(tabId, tab).catch((err) => logWarn(`tab ${tab} not named in herdr-app: ${err.message}`));
    return `Started \`${line}\` as \`${address}\` in ${session} / ${space} / ${tab} (\`${folder}\`). Its ${chat.roomWord} appears in a moment.`;
  }

  async function direct(where, text) {
    const [cmd, ...args] = text.split(/\s+/);
    if (cmd === '/ls') return refreshOverview({ fresh: true });
    if (cmd === '/new') return chat.reply(where, await newTerminal(args));
    if (cmd === '/kill') {
      const [session, address] = args;
      if (!cfg.sessions.includes(session) || !address) throw new Error('give `/kill <session> <address>`');
      await hc.kill(session, address);
      return chat.reply(where, `Ended \`${address}\` in ${session}.`);
    }
    if (await chat.command?.(cmd, args, where)) return null;
    return chat.reply(where, help());
  }

  async function onMessage({ room, where, message, text, images = [] }) {
    try {
      if (!room) {
        if (images.length) await chat.reply(where, `Send images in a terminal's ${chat.roomWord}.`);
        else await direct(where, text);
        return;
      }
      const target = terminalOfRoom(room);
      if (!target) {
        log(`message in a room this bot did not make: ${room}`);
        await chat.reply(where, `Not delivered: this ${chat.roomWord} is not a terminal's. Each terminal has its own ${chat.roomWord}; the direct chat takes /ls, /new and /kill.`);
        return;
      }
      if (views.get(target.session)?.terminals.get(target.address)?.state !== 'live') {
        await chat.reply(where, ENDED_REPLY);
        return;
      }
      const files = await imagesInto(message, target.session, target.address, images);
      await typeInto(where, message, target.session, target.address, [text, ...files].filter(Boolean).join(' '));
    } catch (err) {
      logError(`message to ${where}:`, err);
      await chat.reply(where, `Not delivered: ${plainError(err)}`).catch(() => {});
    }
  }

  // ---------- start ----------

  const timers = [];
  function start({ onReady = () => {} } = {}) {
    log(`herdrchat (${chat.name}): sessions ${cfg.sessions.join(', ')}`);
    if (!chat.ready()) log('owner not set: no rooms are made until it is. Send the bot any direct message.');
    coresRead = readCores();
    ready = Promise.all([coresRead, ...[...firstSnapshot.values()].map((x) => x.promise)]);
    chat.start({ onMessage, onAction, onReady });
    for (const session of cfg.sessions) watch(session);
    ready.then(() => setTimeout(async () => {
      await endGone().catch((err) => logError(`end gone rooms: ${err.message}`));
      // messages held before a restart, for terminals that no longer wait
      for (const k of Object.keys(read().waiting || {})) {
        const address = addressOfKey(k);
        if (!cfg.sessions.some((s) => views.get(s)?.terminals.get(address)?.status?.state === 'blocked')) sendWaiting(k);
      }
      // pins left from before a restart, for terminals that no longer wait
      for (const k of chat.pinned()) {
        const address = addressOfKey(k);
        if (!cfg.sessions.some((s) => views.get(s)?.terminals.get(address)?.status?.state === 'blocked')) await chat.unpin(k);
      }
    }, 0));
    timers.push(setInterval(() => readCores().then(() => cfg.sessions.forEach(sweep)), SWEEP_MS));
    timers.push(setInterval(() => cfg.sessions.forEach((s) => claimAsks(s, { everywhere: true }).catch(() => {})), SWEEP_MS));
    timers.push(setInterval(() => cfg.sessions.forEach(live), LIVE_MS));
    timers.push(setInterval(() => cfg.sessions.forEach((s) => { if (asksWaiting() || labelsOut(s)) claimAsks(s).catch((err) => logWarn(`asks of ${s} not looked at (${err.message})`)); }), ASKS_MS));
    return ready;
  }
  const stop = () => timers.splice(0).forEach(clearInterval);

  // for tests: what the timers would do, now
  const tick = { sweep: () => cfg.sessions.forEach(sweep), live: () => cfg.sessions.forEach(live), asks: () => Promise.all(cfg.sessions.map((s) => claimAsks(s, { everywhere: true }))), endGone, idle: () => Promise.all([...lanes.values()]) };

  return { start, stop, onMessage, onAction, key, scopeOfKey, laneOf, tick };
}
