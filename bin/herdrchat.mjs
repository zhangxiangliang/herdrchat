#!/usr/bin/env node
// herdrchat: every herdr-app tab, mirrored into a chat app. This file only wires the
// parts together: the config, the log, the chat app (lib/chats/, picked by
// HERDRCHAT_CHAT) and the core (lib/core/engine.mjs), which does the work.
//
// Usage: node bin/herdrchat.mjs (`herdrchat start` keeps it running)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STATE_DIR, chatOf, loadConfig, makeDirs, readState, setConfigValue, writeState } from '../lib/core/config.mjs';
import { tryPairing } from '../lib/core/pairing.mjs';
import { createEngine } from '../lib/core/engine.mjs';
import { followEvents } from '../lib/core/events.mjs';
import { cores, getTerminal, hc, keys, label, machines, nameTab, put, run, screenTail, send } from '../lib/core/hc.mjs';
import { refreshHook } from '../lib/core/hooks.mjs';
import { createLog } from '../lib/core/log.mjs';
import { createUpdater } from '../lib/core/updater.mjs';
import * as words from '../lib/core/words.mjs';
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
  // the pairing code from `herdrchat setup`: its sender becomes the owner, written to
  // config.env; the bot then starts again (its service or terminal brings it back) as theirs
  claimOwner: (text, key, id) => {
    const result = tryPairing(store, text);
    if (result === 'ok') {
      setConfigValue(cfg.configFile, key, id);
      log(`paired: ${key} set; starting again as the owner's`);
      setTimeout(() => process.exit(0), 2000);
    }
    return result;
  },
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
  await chat.tellOwner(words.down(down.why));
}
async function sayBack() {
  const state = readState();
  const { down } = state;
  if (!down) return;
  delete state.down;
  writeState(state);
  if (!chat.ready()) return;
  const minutes = Math.max(1, Math.round((Date.now() - down.since) / 60000));
  await chat.tellOwner(words.back(minutes, down.why));
}
logger.capture({ onCrash: sayCrash });

// a newer herdrchat: said, offered, and started again on (lib/core/updater.mjs)
const updater = createUpdater({ root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), store, chat, log, logWarn, logError, refreshHook });
let updaterStarted = false;

engine = createEngine({
  cfg,
  chat,
  hc: { followEvents, cores, machines, getTerminal, screenTail, send, keys, label, put, run, nameTab, kill: (session, address) => hc(session, ['kill', address]) },
  readers,
  store,
  log,
  logWarn,
  logError,
  ownerActions: updater.actions,
});
engine.start({
  onReady: () => {
    sayBack().catch((err) => logError(`back notice: ${err.message}`));
    if (!updaterStarted) {
      updaterStarted = true;
      updater.start().catch((err) => logError(`updater: ${err.message}`));
    }
  },
});
