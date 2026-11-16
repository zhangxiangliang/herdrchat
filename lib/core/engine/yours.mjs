// The core taking what you send: a message or an image into its terminal (held while it
// waits on a dialog), its working and done marks, the overview, and the direct chat's
// commands (/usage: ../usage.mjs).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { askOf } from '../asks.mjs';
import { accountsEverywhere } from '../usage.mjs';
import { machineOf, plainError, tidyScreen } from '../hc.mjs';
import * as words from '../words.mjs';
import { SHELL_ECHO_MS, TURN_SCREEN_LINES, START_WAIT_MS, OVERVIEW_WAIT_MS, OVERVIEW_AGAIN_MS } from './limits.mjs';

export function createYours(ctx) {
  const { agentOf, answerFree, askedNow, backfill, cfg, chat, latestOf, noteHandled, noteOf, overviewSent, seen, closeCard, fromChat, gateNow, handles, hc, inbox, key, laneOf, later, log, logError, logWarn, notStarted, openCard, postBlocked, postGate, quick, read, roomName, screen, shell, shownWhere, since, sleep, startingOf, terminalOfRoom, timers, unanswered, usageOn, views, write } = ctx;

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
      await chat.reply(where, words.ENDED_REPLY);
      return;
    }
    const agent = agentOf(record);
    if (text === '/kill') {
      // its own room: no address to give (the direct chat's /kill takes one)
      await hc.kill(session, address);
      await chat.reply(where, words.killed(address, session));
      return;
    }
    if (text === '/history') {
      const k = key(session, address);
      const c = read().chats[k];
      if (!agent || !c) await chat.reply(where, words.NO_CONVERSATION);
      else await backfill(session, record, k, c.chat, c.name);
      return;
    }
    if (text === '/screen' || text === '/esc') {
      if (text === '/esc') {
        const asked = agent?.dialog ? await agent.dialog(session, address).catch(() => null) : null;
        if (asked) await agent.answer(session, address, asked, { esc: true });
        else await hc.keys(session, address, ['esc']);
        if (asked?.idle) await closeCard(key(session, address), words.CANCELLED_DONE);
      }
      await chat.reply(where, [...(text === '/esc' ? [{ kind: 'text', markdown: words.ESC_PRESSED_SCREEN }] : []), await screen(session, address)]);
      return;
    }
    const answer = text.match(/^\/answer\s+([\s\S]+)$/);
    // whether it waits on a dialog now: asked of hc, since the status followed from its
    // events can be a moment behind (a dialog just answered still looks blocked)
    // Before its agent starts, what it asks takes no words either: Enter would pick the
    // option its cursor is on (for Claude Code's "trust this folder", "No, exit").
    const term = answer || (!agent && !startingOf(record)) ? null : await hc.getTerminal(session, address).catch(() => record);
    const gate = term && !agent ? await gateNow(session, address, term) : null;
    const waits = Boolean(gate || (term && (term.status?.state === 'blocked' || askOf(term))));
    if (waits) {
      // It waits on a dialog: words go into its "Type something" box when it has one;
      // otherwise they wait for the dialog to be answered, then go in (never dropped).
      const menu = gate ? gate.menu : (await askedNow(session, address, record, record.status)).menu;
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
          await (gate ? postGate(session, address, record) : postBlocked(session, address, { ...record, status }, { again: true })).catch((err) => logError(`dialog card for ${session}/${address} not posted (${err.message})`));
        }
        await chat.reply(where, openCard.has(k) || !menu ? words.ASKS_FIRST : words.ASKS_FIRST_IN_APP);
      }
      return;
    }
    try {
      const typed = answer ? answer[1] : text;
      const before = agentOf(record) ? await hc.screenTail(session, address, TURN_SCREEN_LINES).catch(() => '') : null;
      await hc.send(session, address, typed, { force: Boolean(answer) });
      const k = key(session, address);
      fromChat.set(k, [...(fromChat.get(k) || []).slice(-20), typed.trim()]);
      if (before !== null) {
        const entry = { screen: tidyScreen(before), sent: typed, started: false };
        unanswered.set(k, entry);
        timers.push(setTimeout(() => later(session, address, 'not started', () => notStarted(session, address, entry)), quick ? 30 : START_WAIT_MS));
      }
      log(`-> ${session}/${address}: ${text.slice(0, 80)}`);
      await markWorking(k, message);
    } catch (err) {
      // the screen only when it helps: it waits on something you can answer from there
      const waits = /blocked/i.test(err.message);
      await chat.reply(where, [{ kind: 'text', markdown: words.notDelivered(plainError(err)) }, ...(waits ? [await screen(session, address), { kind: 'text', markdown: words.WAITS_ON_DIALOG }] : [])]);
      return;
    }
    // Anything but an agent posts nothing by itself: what you typed gets one look at its
    // screen in reply.
    if (!agent) {
      await sleep(SHELL_ECHO_MS);
      await chat.reply(where, [await screen(session, address)]);
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
  // OVERVIEW_WAIT_MS make one update, an edit (no ring); a row whose note (notes.mjs) is
  // not handled yet is marked. A note makes it come again as a new message, which rings;
  // notes within OVERVIEW_WAIT_MS ring once, and one already handled by then (a dialog
  // answered at once) rings nothing. The one it replaces becomes the record of what it
  // rang for (notes.mjs). One showing at a time, in order, so an edit never lands on the
  // one a new one replaces.
  function overviewRows() {
    const rows = [];
    for (const session of cfg.sessions) {
      for (const record of views.get(session)?.terminals.values() || []) {
        const where = shownWhere(record);
        if (!where || !handles(session, record.address)) continue;
        const k = key(session, record.address);
        const note = noteOf(k);
        rows.push({
          name: roomName(where, record),
          address: session === cfg.sessions[0] || machineOf(record.address) ? record.address : `${session} ${record.address}`,
          state: record.status?.state,
          kind: record.status?.kind,
          program: record.foreground?.name || record.agent,
          since: since.get(k),
          room: read().chats[k]?.chat,
          latest: latestOf(k)?.line || '',
          latestAt: latestOf(k)?.at || null,
          ...(note ? { note } : {}),
        });
      }
    }
    return rows;
  }
  let showing = Promise.resolve();
  // `keys`: the rooms whose note this showing rings for
  const refreshOverview = (opts = {}, keys = []) => {
    const next = showing.then(async () => {
      const sent = await chat.showOverview(overviewRows(), opts);
      if (sent?.message) await overviewSent(sent.message, sent.old, keys);
    });
    showing = next.catch(() => {});
    return next;
  };
  let overviewTimer = null;
  const ringing = new Set(); // rooms whose note the next showing rings for
  function scheduleOverview() {
    if (overviewTimer) return;
    overviewTimer = setTimeout(() => {
      overviewTimer = null;
      const ring = [...ringing].filter((k) => noteOf(k));
      ringing.clear();
      refreshOverview(ring.length ? { fresh: true, ring: true } : {}, ring).catch((err) => {
        // it did not get through (the network): shown again in a while, whatever changes;
        // one that was to ring still rings
        if (!err.unreached) return logError(`overview: ${err.message}`);
        ring.forEach((k) => ringing.add(k));
        logWarn(`overview not shown (${err.message}); trying again in ${OVERVIEW_AGAIN_MS / 1000} s`);
        timers.push(setTimeout(scheduleOverview, quick ? 5 : OVERVIEW_AGAIN_MS));
      });
    }, quick ? 5 : OVERVIEW_WAIT_MS);
  }
  function ringOverview(k) {
    ringing.add(k);
    scheduleOverview();
  }

  const help = () => words.help(chat.help || [], chat.roomWord);

  async function newTerminal(args) {
    let cwd = null;
    if (args[0] === '--cwd') {
      cwd = args[1];
      args = args.slice(2);
    }
    const [session, place, ...command] = args;
    if (!cfg.sessions.includes(session)) throw new Error(words.unknownSession(session, cfg.sessions));
    const slash = (place || '').indexOf('/');
    if (slash < 1 || slash === place.length - 1) throw new Error(words.GIVE_PLACE);
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
    return words.started({ line, address, session, space, tab, folder, roomWord: chat.roomWord });
  }

  async function direct(where, text) {
    const [cmd, ...args] = text.split(/\s+/);
    if (cmd === '/ls') return refreshOverview({ fresh: true });
    if (cmd === '/new') return chat.reply(where, await newTerminal(args));
    if (cmd === '/kill') {
      const [session, address] = args;
      if (!cfg.sessions.includes(session) || !address) throw new Error(words.GIVE_KILL);
      await hc.kill(session, address);
      return chat.reply(where, words.killed(address, session));
    }
    if (cmd === '/usage') return chat.reply(where, words.usageReport(await accountsEverywhere({ sessions: cfg.sessions, machines: hc.machines, shell, usageOn })));
    if (await chat.command?.(cmd, args, where)) return null;
    return chat.reply(where, help());
  }

  async function onMessage({ room, where, message, text, images = [] }) {
    try {
      if (!room) {
        if (images.length) await chat.reply(where, words.imagesInRoom(chat.roomWord));
        else await direct(where, text);
        return;
      }
      const target = terminalOfRoom(room);
      // A command in a room no terminal has is the direct chat's, answered there: Telegram
      // makes a new topic of what you send outside one (a bot that lets users make topics),
      // so a command picked from its "/" list never reaches the main thread.
      if (!target && text.startsWith('/') && !images.length) {
        await direct(where, text);
        return;
      }
      if (!target) {
        log(`message in a room this bot did not make: ${room}`);
        await chat.reply(where, words.notARoom(chat.roomWord));
        return;
      }
      if (views.get(target.session)?.terminals.get(target.address)?.state !== 'live') {
        await chat.reply(where, words.ENDED_REPLY);
        return;
      }
      // you are in the room: its note is handled (one not sent yet is not sent), and what
      // it asks next waits a moment
      seen(key(target.session, target.address));
      noteHandled(key(target.session, target.address), 'replied');
      const files = await imagesInto(message, target.session, target.address, images);
      await typeInto(where, message, target.session, target.address, [text, ...files].filter(Boolean).join(' '));
    } catch (err) {
      logError(`message to ${where}:`, err);
      await chat.reply(where, words.notDelivered(plainError(err))).catch(() => {});
    }
  }

  return { direct, markDone, onMessage, ringOverview, scheduleOverview, sendWaiting };
}
