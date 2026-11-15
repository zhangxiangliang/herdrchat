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
//   post(room, body, {footer}) -> message; reply(where, body)   body: blocks (lib/chats/
//                                 blocks.mjs: text, screen) or markdown
//   postCard(room, look) -> message; editCard(message, look)   look: {title, tone, markdown, footer}
//   postDialog(room, dialog, value) -> message; closeDialog(message, dialog, done)
//                                 a footer (also dialog.footer) is one small line under a post:
//                                 the harness and model it came from, as herdrchat knows them,
//                                 as {app, model, screen, branch, context, limits}; the app says
//                                 it with footer() from words.mjs
//   pin(k, room, message); unpin(k); pinned() -> keys; ring(k, message, text)
//   markWorking(message) -> token; markDone(message, token)
//   image(buffer) -> markdown; download(message, ref, file)
//   postFile(room, {name, data, caption}); postFolded(room, {title, markdown}); foldedBytes
//   tellOwner(look) (look.buttons: [{label, value}]: a tap is a click with that value);
//   showOverview(rows, {fresh}); split(text) -> parts; liveBytes
//
// Its parts are in engine/: rooms.mjs (a room per tab), turns.mjs (what a terminal says),
// dialogs.mjs (what it waits on, and your taps), follow.mjs (hc's events and the sweep),
// yours.mjs (what you send, the overview, the direct chat). This file makes them, with
// what they share: which terminals are this bot's, and the lanes their work runs in.

import os from 'node:os';
import path from 'node:path';
import { askOpen, asksHere } from './asks.mjs';
import { isUnavailable, machineOf, plainError } from './hc.mjs';
import { homeShell } from './home.mjs';
import { coreViews } from './views.mjs';
import { ASKS_MS, LIVE_MS, SWEEP_MS } from './engine/limits.mjs';
import { createRooms } from './engine/rooms.mjs';
import { createTurns } from './engine/turns.mjs';
import { createDialogs } from './engine/dialogs.mjs';
import { createFollow } from './engine/follow.mjs';
import { createYours } from './engine/yours.mjs';

// hc: {followEvents, cores, machines, getTerminal, screenTail, send, keys, put, run, kill,
// nameTab?(tabId, name): name a tab in herdr-app, when it runs here};
// readers: {agentOf, readerFor}; store: {read, write} of state.json; inbox: a folder for
// images on their way to a terminal; quick: shorter waits (tests).
export function createEngine({ cfg, chat, hc, readers, store, log, logWarn, logError, startedAt = new Date().toISOString(), inbox = path.join(os.tmpdir(), 'herdrchat-inbox'), quick = false, asksWaiting = asksHere, askLives = askOpen, shell = homeShell, ownerActions = {} }) {
  const { read, write } = store;
  const { agentOf, readerFor } = readers;
  const startingOf = readers.startingOf || (() => null);
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

  // ---------- the parts ----------

  // what they share; each part adds what it gives, in this order (a part finds one made
  // after it through late(), when it runs)
  const timers = [];
  const ctx = { cfg, chat, hc, read, write, log, logWarn, logError, startedAt, inbox, quick, asksWaiting, askLives, shell, ownerActions, agentOf, readerFor, startingOf, sleep, views, lanes, firstSnapshot, timers, reachable, handles, key, scopeOfKey, addressOfKey, laneOf, later };
  for (const make of [createRooms, createTurns, createDialogs, createFollow, createYours]) Object.assign(ctx, make(ctx));
  const { endRoom, onAction, onMessage, sendWaiting, watch, sweep, live, claimAsks, labelsOut } = ctx;

  // ---------- start ----------

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
