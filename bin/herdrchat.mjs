#!/usr/bin/env node
// herdrchat: every herdr-app tab, mirrored into a chat app. This file only wires the
// parts together: the config, the log, the chat app (lib/chats/, picked by
// HERDRCHAT_CHAT) and the core (lib/core/engine.mjs), which does the work.
//
// Usage: node bin/herdrchat.mjs (`herdrchat start` keeps it running)
import path from 'node:path';
import { STATE_DIR, chatOf, loadConfig, makeDirs, readState, writeState } from '../lib/core/config.mjs';
import { createEngine } from '../lib/core/engine.mjs';
import { followEvents } from '../lib/core/events.mjs';
import { cores, getTerminal, hc, keys, machines, put, run, screenTail, send } from '../lib/core/hc.mjs';
import { createLog } from '../lib/core/log.mjs';
import * as readers from '../lib/core/readers/index.mjs';
import { chatModule, createChat } from '../lib/chats/index.mjs';

makeDirs();
const logger = createLog(path.join(STATE_DIR, 'logs'));
const log = logger.info;
const logWarn = logger.warn;
const logError = logger.error;
const store = { read: readState, write: writeState };

const cfg = loadConfig({ requires: chatModule(chatOf()).requires || [] });

// The core is made after the chat app, which needs the core's lanes and keys: these
// forward to it.
let engine = null;
const chat = createChat(cfg.chat, {
  cfg,
  store,
  log,
  logWarn,
  logError,
  stateDir: STATE_DIR,
  lane: (k, label, fn) => engine.laneOf(k, label, fn),
  scopeOf: (k) => engine.scopeOfKey(k),
});

// A bot that is down is a phone that hears nothing, so down time is said in the direct
// chat: a crash says why (at most once per CRASH_NOTICE_MS, as a restart loop repeats
// it), and the next connection says how long it was gone.
const CRASH_NOTICE_MS = 10 * 60 * 1000;
async function sayCrash(err) {
  if (!chat.ready()) return;
  const now = Date.now();
  const state = readState();
  const down = { since: now, said: 0, ...state.down, why: String(err?.message || err).slice(0, 300) };
  const say = now - down.said >= CRASH_NOTICE_MS;
  if (say) down.said = now;
  state.down = down;
  writeState(state);
  if (!say) return;
  await chat.tellOwner({ title: '🔴 herdrchat is down', tone: 'bad', markdown: `herdrchat stopped: ${down.why}\n\nIt is being started again. Until it is back, nothing you send here reaches your terminals.` });
}
async function sayBack() {
  const state = readState();
  const { down } = state;
  if (!down) return;
  delete state.down;
  writeState(state);
  if (!chat.ready()) return;
  const minutes = Math.max(1, Math.round((Date.now() - down.since) / 60000));
  await chat.tellOwner({ title: '✅ herdrchat is back', tone: 'good', markdown: `herdrchat is back after about ${minutes} min. What stopped it: ${down.why}` });
}
logger.capture({ onCrash: sayCrash });

engine = createEngine({
  cfg,
  chat,
  hc: { followEvents, cores, machines, getTerminal, screenTail, send, keys, put, run, kill: (session, address) => hc(session, ['kill', address]) },
  readers,
  store,
  log,
  logWarn,
  logError,
});
engine.start({ onReady: () => sayBack().catch((err) => logError(`back notice: ${err.message}`)) });
