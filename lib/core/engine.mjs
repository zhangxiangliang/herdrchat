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
//   post(room, markdown) -> message; reply(where, markdown)
//   postCard(room, look) -> message; editCard(message, look)   look: {title, tone, markdown}
//   postDialog(room, dialog, value) -> message; closeDialog(message, dialog, done)
//   pin(k, room); unpin(k); pinned() -> keys; ring(k, message, text)
//   markWorking(message) -> token; markDone(message, token)
//   image(buffer) -> markdown; download(message, ref, file)
//   postFile(room, {name, data, caption}); postFolded(room, {title, markdown}); foldedBytes
//   tellOwner(look); showOverview(rows, {fresh}); split(text) -> parts; liveBytes
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { advance, startCursor } from './cursor.mjs';
import { isUnavailable, machineOf, plainError, splitWhere, tidyScreen } from './hc.mjs';
import { menuOf } from './menu.mjs';
import { coreViews } from './views.mjs';

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
const CLICK_BUDGET_MS = 2000; // a click must be answered within 3 s
const OVERVIEW_WAIT_MS = 2000;
const UPLOAD_TRIES = 3;
const DRAW_TRIES = 3;
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

// hc: {followEvents, cores, machines, getTerminal, screenTail, send, keys, put, run, kill};
// readers: {agentOf, readerFor}; store: {read, write} of state.json; inbox: a folder for
// images on their way to a terminal; quick: shorter waits (tests).
export function createEngine({ cfg, chat, hc, readers, store, log, logWarn, logError, startedAt = new Date().toISOString(), inbox = path.join(os.tmpdir(), 'herdrchat-inbox'), quick = false }) {
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
    const title = String(record.title || '').replace(/^[^\p{L}\p{N}]+/u, '').replace(/\s+/g, ' ').trim();
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
      if (it.role === 'you') parts.push(`**You** · ${clock(it.at)}\n${it.text.split('\n').map((l) => `> ${l}`).join('\n')}`);
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
    const items = (all?.items || []).filter((it) => it.at <= until);
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
  const postTo = (session, record, text) => deliver(session, record, (room) => chat.post(room, text));

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
        parts.push(`**You:**\n${it.text.split('\n').map((l) => `> ${l}`).join('\n')}`);
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
  async function newLive(session, record, text) {
    const parts = chat.split(text);
    let message = null;
    for (const [i, part] of parts.entries()) {
      const last = i === parts.length - 1;
      message = await deliver(session, record, (room) => chat.postCard(room, { title: last ? LIVE_TITLE : FULL_TITLE, tone: last ? 'working' : 'closed', markdown: part }));
    }
    return message ? { message, text: parts[parts.length - 1] } : null;
  }

  async function addLive(session, record, live, add) {
    if (!live) return newLive(session, record, add);
    const text = `${live.text}\n\n${add}`;
    if (Buffer.byteLength(text) > chat.liveBytes) {
      await closeLive(live, FULL_TITLE);
      return newLive(session, record, add);
    }
    try {
      await chat.editCard(live.message, { title: LIVE_TITLE, tone: 'working', markdown: text });
      return { message: live.message, text };
    } catch (err) {
      logError(`live card ${live.message} not editable (${err.message}); sending it again`);
      return newLive(session, record, text);
    }
  }

  async function closeLive(live, title = CLOSED_TITLE) {
    try {
      await chat.editCard(live.message, { title, tone: 'closed', markdown: live.text });
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
    if (tailText) await chat.ring(k, await postTo(session, record, tailText), '✅ done');
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
    await chat.ring(key(session, address), await postTo(session, record, await screen(session, address, TURN_SCREEN_LINES)), '✅ done');
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
  function dialogOf(status, screenText) {
    const menu = menuOf(screenText);
    const title = `${NEEDS_TITLE}${status?.kind ? ` (${status.kind})` : ''}`;
    const markdown = menu ? escapeMarkdown(menu.text) : `\`\`\`\n${tidyScreen(screenText, DIALOG_LINES)}\n\`\`\``;
    return { menu, title, markdown, doneTitle: DONE_TITLE };
  }
  const dialogValue = (session, address, dialog) => ({ s: session, a: address, k: dialog.menu.key });

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
  // its buttons and says so, so the room never shows a question nobody waits on.
  const openCard = new Map(); // terminal key -> {message, dialog}
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
  // the moment `blocked` arrives may come before the dialog is drawn: with no menu on it,
  // the screen is read again a few times.
  async function postBlocked(session, address, record, { screen: first = null, again = false } = {}) {
    const firstScreen = await first;
    let dialog = firstScreen ? dialogOf(record.status, firstScreen) : null;
    for (let i = 0; i < DRAW_TRIES && !dialog?.menu; i += 1) {
      if (i) await sleep(DRAW_WAIT_MS);
      dialog = dialogOf(record.status, await hc.screenTail(session, address, SCREEN_LINES));
    }
    const k = key(session, address);
    if (!claimDialog(k, dialog, record.status) && !again) return;
    await closeCard(k, 'It moved on; see the next card.');
    if (!dialog.menu) {
      const sent = await postTo(session, record, `**${dialog.title}**\n\n${dialog.markdown}\n\nReply \`/answer <text>\` to answer it, or \`/esc\` to cancel it.`);
      const room = read().chats[k]?.chat;
      if (room) await chat.pin(k, room);
      await chat.ring(k, sent, '⚠️ needs you');
    } else {
      const message = await deliver(session, record, (room) => chat.postDialog(room, dialog, dialogValue(session, address, dialog)));
      if (message) {
        remember(message, dialog);
        openCard.set(k, { message, dialog });
        const room = read().chats[k]?.chat;
        if (room) await chat.pin(k, room);
        await chat.ring(k, message, '⚠️ needs you');
        // answered while the card was on its way: nothing will close it later, so now
        const live = views.get(session)?.terminals.get(address);
        if (live?.status?.state !== 'blocked' || postedDialog.get(k) !== dialogName(dialog, record.status)) await closeCard(k, '✔ Answered.');
      }
    }
    log(`<- ${session}/${address}: blocked${dialog.menu ? ` (${dialog.menu.options.length} options)` : ''}`);
  }

  // "Type something": pick that option, then type the words.
  async function answerFree(session, address, menu, text) {
    await hc.keys(session, address, [String(menu.free.n)]);
    await sleep(300);
    await hc.send(session, address, text, { force: true });
  }

  const toast = (type, text) => ({ toast: { type, text } });
  const answered = (shown, done) => ({ ...toast('info', done), card: { kind: 'done', dialog: shown, done } });

  // A click on a dialog card. The screen is read again first, and nothing is pressed
  // unless it still shows the dialog the card was made from (same key) with the same
  // option. After the key, the card turns into the dialog's next step (the next question,
  // the review, a toggled box) or says what was picked.
  async function onAction({ value: v = {}, message, answer = '' }) {
    const started = Date.now();
    const shown = dialogCards.get(message) || { title: NEEDS_TITLE, markdown: '', doneTitle: DONE_TITLE };
    const record = views.get(v.s)?.terminals.get(v.a);
    if (!record || record.state !== 'live') return answered(shown, 'The terminal has ended.');
    const status = (await hc.getTerminal(v.s, v.a)).status;
    const menu = status?.state === 'blocked' ? menuOf(await hc.screenTail(v.s, v.a, SCREEN_LINES)) : null;
    if (!menu || menu.key !== v.k) {
      if (menu) later(v.s, v.a, 'dialog', () => postBlocked(v.s, v.a, { ...record, status }));
      return answered(shown, menu ? 'It now asks something else; see the new card.' : 'It no longer waits on this.');
    }
    const k = key(v.s, v.a);
    if (openCard.get(k)?.message === message) openCard.delete(k);
    let picked;
    if (v.pick === 'esc' || v.pick === 'tab') {
      await hc.keys(v.s, v.a, [v.pick]);
      picked = v.pick === 'esc' ? 'Esc pressed' : 'Next';
    } else {
      const option = menu.options.find((o) => o.n === v.pick);
      if (!option || option.label !== v.label) return answered(shown, 'The options changed; nothing was pressed.');
      if (option === menu.free) {
        const text = answer.trim();
        if (!text) return toast('warning', 'Type your answer first.');
        await answerFree(v.s, v.a, menu, text);
        picked = text;
      } else {
        await hc.keys(v.s, v.a, [String(option.n)]);
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
      const next = dialogOf(nextStatus, await hc.screenTail(v.s, v.a, SCREEN_LINES));
      // the same dialog (a toggled box) is redrawn here; a new one only if no card has it yet
      if (next.menu && (next.menu.key === v.k || claimDialog(k, next, nextStatus))) {
        remember(message, next);
        openCard.set(k, { message, dialog: next });
        return { ...toast('info', `✔ ${picked}`), card: { kind: 'dialog', dialog: next, value: dialogValue(v.s, v.a, next) } };
      }
      if (next.menu) return answered(shown, `✔ ${picked}`); // its card is out already
      // still waiting, on something with no menu: hc sends no new turn for it, so post it
      later(v.s, v.a, 'dialog', () => postBlocked(v.s, v.a, { ...record, status: nextStatus }));
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
      if (['working', 'blocked'].includes(record.status?.state)) continue;
      later(session, record.address, 'sweep', async () => {
        await postRead(session, record.address, record, reader, { waitForEnd: false });
        await markDone(key(session, record.address), { olderThan: SWEEP_DONE_MS }); // a turn end that was missed
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
      postedDialog.delete(k);
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
          await postTurn(session, address, record);
          await markDone(key(session, address));
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
      if (text === '/esc') await hc.keys(session, address, ['esc']);
      await chat.reply(where, `${text === '/esc' ? 'Esc pressed.\n\n' : ''}${await screen(session, address)}`);
      return;
    }
    const answer = text.match(/^\/answer\s+([\s\S]+)$/);
    if (!answer && agent && record.status?.state === 'blocked') {
      // It waits on a dialog: words go into its "Type something" box when it has one;
      // otherwise the dialog card comes again, to pick there.
      const menu = menuOf(await hc.screenTail(session, address, SCREEN_LINES));
      if (menu?.free) {
        await answerFree(session, address, menu, text);
        log(`-> ${session}/${address}: answered ${text.slice(0, 80)}`);
        await markWorking(key(session, address), message);
      } else {
        await postBlocked(session, address, record, { again: true });
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
      const hint = /blocked/i.test(err.message) ? '\n\nIt waits on a dialog. Reply `/answer <text>` to answer it, or `/esc` to cancel it.' : '';
      await chat.reply(where, `Not delivered: ${plainError(err)}\n\n${await screen(session, address)}${hint}`);
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
    'In a terminal\'s room: type to talk to it; `/screen`, `/answer <text>`, `/esc`, `/history` (the conversation so far, as a file).',
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
    const out = await hc.run(session, {
      cwd: folder,
      labels: { 'herdr.space': spaceId, 'herdr.tab': `tb${crypto.randomBytes(16).toString('hex')}`, where: `${space} / ${tab}` },
      argv: ['/bin/zsh', '-lc', `exec ${line}`], // login shell for PATH; exec so no bare shell is left behind
    });
    const address = JSON.parse(out).address;
    return `Started \`${line}\` as \`${address}\` in ${session} / ${space} / ${tab} (\`${folder}\`). Its room appears in a moment.`;
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
        if (images.length) await chat.reply(where, 'Send images in a terminal\'s room.');
        else await direct(where, text);
        return;
      }
      const target = terminalOfRoom(room);
      if (!target) {
        log(`message in a room this bot did not make: ${room}`);
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
      // pins left from before a restart, for terminals that no longer wait
      for (const k of chat.pinned()) {
        const address = addressOfKey(k);
        if (!cfg.sessions.some((s) => views.get(s)?.terminals.get(address)?.status?.state === 'blocked')) await chat.unpin(k);
      }
    }, 0));
    timers.push(setInterval(() => readCores().then(() => cfg.sessions.forEach(sweep)), SWEEP_MS));
    timers.push(setInterval(() => cfg.sessions.forEach(live), LIVE_MS));
    return ready;
  }
  const stop = () => timers.splice(0).forEach(clearInterval);

  // for tests: what the timers would do, now
  const tick = { sweep: () => cfg.sessions.forEach(sweep), live: () => cfg.sessions.forEach(live), endGone, idle: () => Promise.all([...lanes.values()]) };

  return { start, stop, onMessage, onAction, key, scopeOfKey, laneOf, tick };
}
