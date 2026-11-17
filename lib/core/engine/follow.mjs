// The core following hc: its events (status, labels, a turn's end), the sweep that
// catches what an event missed, and the live posts while an agent works.
import { LABEL, askOf } from '../asks.mjs';
import { machineOf } from '../hc.mjs';
import * as words from '../words.mjs';
import { SCREEN_LINES, SWEEP_DONE_MS } from './limits.mjs';
import { late } from './late.mjs';

export function createFollow(ctx) {
  const { agentOf, askLives, asksWaiting, chat, fillLatest, noteHandled, closeCard, ensureRoom, firstSnapshot, gated, handles, hc, key, later, log, logError, lookForGate, openCard, postBlocked, postEnd, postGate, postIdleAsk, postRead, postTurn, postedDialog, reachable, roomOf, shownWhere, unanswered, views } = ctx;
  const { markDone, scheduleOverview, sendWaiting } = late(ctx, ['markDone', 'scheduleOverview', 'sendWaiting']);

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
    for (const record of views.get(session)?.terminals.values() || []) {
      if (gated(record) && shownWhere(record) && handles(session, record.address) && reachable(session, record.address) && !openCard.has(key(session, record.address))) {
        later(session, record.address, 'dialog', () => postGate(session, record.address, record));
      }
    }
    for (const { record, reader } of readable(session)) {
      // the overview's latest line, read once for a room that has none
      later(session, record.address, 'latest', () => fillLatest(session, record.address, key(session, record.address), reader));
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
          if (now?.key !== open.key) await closeCard(k, words.ANSWERED);
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
    // working again: what its note said is moving on (a "done" not sent yet is not sent)
    if (now === 'working' && was !== 'working') noteHandled(k, 'working');
    if (['working', 'blocked'].includes(now) && unanswered.has(k)) unanswered.get(k).started = true;
    if (now !== 'blocked') {
      // its hook still asks (Codex works on meanwhile): the card stays, and so do messages
      if (askOf(record) && openCard.get(k)?.dialog?.menu?.own) return;
      // a question that leaves it idle waits on your next message: its card stays till then
      if (openCard.get(k)?.dialog?.menu?.own?.idle && now !== 'working') return;
      postedDialog.delete(k);
      if (now && !askOf(record)) sendWaiting(k);
      if (chat.pinned().includes(k)) later(session, address, 'unpin', () => chat.unpin(k));
      noteHandled(k, 'answered', { asks: true });
      if (openCard.has(k)) later(session, address, 'dialog', () => closeCard(k, words.ANSWERED));
      // stopped at its dialog (Esc): it went from asking to waiting without working, so hc
      // sends no turn event, and this is the turn's end
      const reader = was === 'blocked' && now && now !== 'working' && shownWhere(record) && handles(session, address) ? agentOf(record) : null;
      if (reader) {
        later(session, address, 'turn', async () => {
          await postRead(session, address, record, reader, { waitForEnd: true });
          await markDone(k);
        });
      }
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
      if (openCard.get(k)?.dialog?.menu?.own) await closeCard(k, words.ANSWERED);
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
        if (['created', 'restarted'].includes(type)) lookForGate(session, address);
        if (type === 'labels' && record) onAsk(session, address, record);
        if (['created', 'restarted', 'labels', 'status', 'title'].includes(type) && shownWhere(record)) {
          later(session, address, 'room', () => ensureRoom(session, record));
        } else if ((type === 'finished' || type === 'removed') && roomOf(session, address)?.session === session) {
          later(session, address, 'end', () => postEnd(session, address, record || { address }, data?.reason));
        }
      },
      onTurn: ({ address, state, record }) => {
        scheduleOverview();
        log(`turn ${session}/${address}: ${state}${shownWhere(record) ? '' : ' (no room)'}`);
        // a room mirrors agents: a shell or another program posts nothing by itself
        if (!shownWhere(record) || !handles(session, address) || !agentOf(record)) return;
        const screenNow = state === 'blocked' ? hc.screenTail(session, address, SCREEN_LINES).catch(() => null) : null;
        const status = { ...record.status };
        // the message this turn answers: one sent after it ended (while its end is still
        // being read) is the next turn's
        const asked = unanswered.get(key(session, address));
        later(session, address, 'turn', async () => {
          if (state === 'blocked') {
            // what it said before stopping to ask comes first
            const reader = agentOf(record);
            if (reader) await postRead(session, address, record, reader, { waitForEnd: false, asking: true }).catch(() => {});
            await postBlocked(session, address, { ...record, status }, { screen: screenNow });
            return;
          }
          // ended on a question that leaves it idle: no last answer is coming, so what it
          // said goes at once, then the question's card
          const reader = agentOf(record);
          const asks = reader?.asksIdle ? await reader.dialog(session, address).catch(() => null) : null;
          if (asks?.idle) await postRead(session, address, record, reader, { waitForEnd: false, asking: true }).catch((err) => logError(`${session}/${address}: ${reader.app} not readable (${err.message})`));
          else await postTurn(session, address, record, asked);
          await markDone(key(session, address));
          if (reader?.asksIdle) await postIdleAsk(session, address, { ...record, status });
        });
      },
    });
    views.set(session, view);
  }

  return { claimAsks, labelsOut, live, since, sweep, watch };
}
