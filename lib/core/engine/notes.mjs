// The core's notes: what makes the phone ring. Rooms ring nothing of their own (Feishu
// groups muted, Telegram posts silent in HERDR_MUTED_SPACES); a room that needs you, or
// whose turn is done, gets a note, and a note makes the overview in the direct chat come
// again as a new message, which rings: what it rang for first ("waiting for you"). The
// overview before it is never taken back (in Feishu a recall leaves a "recalled a message"
// line): it is edited into the record of what it rang for, one line each, which says
// "handled" once it is. With nothing new the newest overview is only edited (no ring).
//   needs you   at once, unless you are in that room (you wrote or tapped there in the
//               last HERDR_DONE_WAIT): then it waits as "done" does, and an answer
//               meanwhile rings nothing. Handled when the terminal no longer waits (a card
//               answered, your words, an answer in the terminal) or it works again.
//   done        after HERDR_DONE_WAIT (60 s by default), so a turn you watch rings
//               nothing: your next message in its room, or the terminal working again
//               meanwhile, means you saw it; else handled the same ways once out.
// Also handled: you write in the room, or its terminal ends. A room has one note at most:
// a newer one takes its place. A space of HERDR_SILENT_SPACES gets none. Notes and the
// records are kept in state.json (notes, records), so a restart still rings one that was
// waiting and handles one whose terminal moved on meanwhile; a record whose edit did not
// get through is edited again at the sweep.
import { blocksOf } from '../../chats/blocks.mjs';
import { startCursor } from '../cursor.mjs';
import { late } from './late.mjs';
import { DONE_WAIT_MS, NOTE_CHARS, RECORDS_KEPT } from './limits.mjs';

const inSpaces = (set, space) => Boolean(set && (set.all || set.spaces.includes(space)));
const spaceOfName = (name) => (name || '').split(' / ')[0];

// What a note quotes of a post: the first line with words in it, marks taken off. A
// screen says nothing on its own first line, so a post that is only a screen has none.
export function lineOf(body) {
  for (const b of blocksOf(body)) {
    if (!['text', 'plain', 'you'].includes(b.kind)) continue;
    let fence = false;
    for (const raw of String(b.markdown ?? b.text ?? '').split('\n')) {
      if (/^\s*```/.test(raw)) { fence = !fence; continue; }
      let line = raw.replace(/^\s*(>|#+|[-*]\s)\s*/, '').trim();
      // marks off: bold, italic (*a* or _a_, not a word's own _), code, a link's url, escapes
      if (b.kind === 'text' && !fence) line = line.replace(/\*\*|__|`/g, '').replace(/(^|[^\w*])[*_](?!\s)([^*_\n]*[^*_\s])[*_](?=$|[^\w*])/g, '$1$2').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\\([\\`*_[\]#>~|<&])/g, '$1');
      if (!/[\p{L}\p{N}]/u.test(line)) continue;
      return line.length > NOTE_CHARS ? `${line.slice(0, NOTE_CHARS - 1)}…` : line;
    }
  }
  return '';
}

export function createNotes(ctx) {
  const { cfg, chat, laneOf, log, logError, read, timers, write } = ctx;
  const { ringOverview, scheduleOverview } = late(ctx, ['ringOverview', 'scheduleOverview']);
  const doneWait = Number.isFinite(cfg.doneWaitMs) ? cfg.doneWaitMs : DONE_WAIT_MS;

  function keep(k, note) {
    const state = read();
    if (note) state.notes = { ...(state.notes || {}), [k]: note };
    else if (state.notes) delete state.notes[k];
    write(state);
  }

  // You in a room: when you last wrote or tapped there (not kept over a restart).
  const seenAt = new Map();
  const seen = (k) => seenAt.set(k, Date.now());
  const watching = (k) => Date.now() - (seenAt.get(k) || 0) < doneWait;

  // out: the overview marks its room from now on, and comes again as a new message
  function out(k, note) {
    keep(k, { ...note, out: true, due: null });
    log(`note ${note.kind} for ${note.name}`);
    ringOverview(k);
  }

  // A post that rings: `message` is the post (none: nothing was posted), `body` what it
  // said, `kind` needs | done; `asks`: it is a dialog's card (or what stands in for one),
  // handled once the terminal no longer waits on it. It takes the place of the room's
  // note before, which counts as handled.
  async function ring(k, message, kind, body, { asks = false } = {}) {
    if (message) keepLatest(k, lineOf(body));
    const c = read().chats[k];
    if (!message || !c || !chat.ready() || inSpaces(cfg.silent, spaceOfName(c.name))) return;
    await settle(k, 'replaced');
    const note = { kind, name: c.name, room: c.chat, line: lineOf(body), at: Date.now(), ...(asks ? { asks: true } : {}) };
    if (doneWait > 0 && (kind === 'done' || watching(k))) {
      keep(k, { ...note, due: Date.now() + doneWait });
      wake(k, doneWait);
      return;
    }
    out(k, note);
  }

  // one timer at most per room
  const armed = new Set();
  function wake(k, ms) {
    if (armed.has(k)) return;
    armed.add(k);
    timers.push(setTimeout(() => laneOf(k, 'note', async () => {
      armed.delete(k);
      const note = read().notes?.[k];
      // due (a timer may fire a moment early)
      if (note && !note.out && note.due && note.due <= Date.now() + 50) out(k, note);
    }), ms));
  }

  // ---------- records: what each overview that rang rang for ----------

  // state.records: {<overview message>: [{k, kind, name, room, line, at, handled?}]}, the
  // newest RECORDS_KEPT. An overview a newer one replaced shows its record (showRecord);
  // one that rang for nothing (the first, a fresh /ls) shows an empty one ("an old
  // overview").
  const entry = (k, note) => ({ k, kind: note.kind, name: note.name, room: note.room, line: note.line, at: note.at });
  const recordOf = (message) => read().records?.[message] || [];
  const shownNotes = (entries) => entries.map(({ k, ...rest }) => rest);

  // The overview just sent anew (`message`) rang for `keys`; `old` is the one it replaced.
  // Which one is the newest is kept here (state.overviewNow), not read off the app's state.
  async function overviewSent(message, old, keys) {
    const state = read();
    state.overviewNow = message;
    const notes = state.notes || {};
    const rang = keys.filter((k) => notes[k]?.out);
    write(state);
    if (rang.length) {
      for (const k of rang) notes[k].shown = message;
      const records = { ...(state.records || {}), [message]: rang.map((k) => entry(k, notes[k])) };
      const names = Object.keys(records);
      for (const drop of names.slice(0, Math.max(0, names.length - RECORDS_KEPT))) delete records[drop];
      state.records = records;
      write(state);
    }
    if (old) await edit(old, shownNotes(recordOf(old)));
  }

  // a record edited to what it says now; one that did not get through is tried again
  async function edit(message, notes) {
    try {
      await chat.showRecord(message, notes);
    } catch (err) {
      logError(`overview ${message} not made a record: ${err.message}`);
      if (!err.unreached) return;
      const state = read();
      state.recordEdits = [...new Set([...(state.recordEdits || []), message])];
      write(state);
    }
  }
  async function retryEdits() {
    const state = read();
    const edits = state.recordEdits || [];
    if (!edits.length) return;
    delete state.recordEdits;
    write(state);
    for (const message of edits) await edit(message, shownNotes(recordOf(message)));
  }

  // Handled: a note not out yet is dropped; one out takes its room's mark off the overview
  // (an edit: no ring), and the record of the overview it rang in says so. `asks`: only a
  // dialog's note is. `how`: one of words.HANDLED's keys.
  async function settle(k, how, { asks = false } = {}) {
    const note = read().notes?.[k];
    if (!note || (asks && !note.asks)) return;
    keep(k, null);
    if (!note.out) return;
    // a dialog's terminal working again was answered
    const handled = { how: how === 'working' && note.asks ? 'answered' : how, at: Date.now() };
    log(`note ${note.kind} for ${note.name} handled: ${handled.how}`);
    scheduleOverview();
    if (!note.shown) return;
    const state = read();
    const entries = state.records?.[note.shown];
    const mine = entries?.find((e) => e.k === k && e.at === note.at);
    if (!mine) return;
    mine.handled = handled;
    write(state);
    // the newest overview shows it by its marks; an older one is its record
    if (note.shown !== state.overviewNow) await edit(note.shown, shownNotes(entries));
  }
  const settleLater = (k, how, opts) => laneOf(k, 'note', () => settle(k, how, opts));

  // At start and at every sweep: a note that waits goes when due (a restart missed its
  // timer), a record whose edit failed is edited again, and a "needs you" whose terminal
  // waits on nothing now (answered while the bot was down, or before its note was out) is
  // handled. `waits(k)`: whether that terminal still waits on you.
  function notesStale(waits) {
    for (const [k, note] of Object.entries(read().notes || {})) {
      if (!note.out) wake(k, Math.max(0, (note.due || 0) - Date.now()));
      else if (note.asks && !waits(k)) settleLater(k, 'answered');
    }
    return retryEdits().catch((err) => logError(`records: ${err.message}`));
  }

  // What the overview shows as a room's latest: the first line of what it last said that
  // rang (its answer, or what it asks), in every space, silent ones too. A screen has none,
  // so the line before it stays. Kept in state.json (latest).
  function keepLatest(k, line, at = Date.now()) {
    if (!line) return;
    const state = read();
    state.latest = { ...(state.latest || {}), [k]: { line, at } };
    write(state);
  }
  // {line, at} or null
  const latestOf = (k) => read().latest?.[k] || null;

  // A room with no latest line yet (new to this, or before the bot kept them): the last
  // answer in its agent's own records, read until one is found (as a new room's history
  // is read). In its lane.
  const looked = new Set();
  async function fillLatest(session, address, k, reader) {
    if (looked.has(k) || latestOf(k)) return;
    // one with no answer yet (a new conversation: short to read), or that could not be read
    // (its machine away), is looked at again at the next sweep
    const all = await reader.after(session, address, startCursor('0000-00-00T00:00:00.000Z'));
    const last = [...(all?.items || [])].reverse().find((it) => it.role === 'ai' && it.text);
    if (!last) return;
    looked.add(k);
    if (latestOf(k)) return;
    keepLatest(k, lineOf([{ kind: 'text', markdown: last.text }]), Date.parse(last.at) || Date.now());
    scheduleOverview();
  }

  // what the overview shows of a room's note: one out, not yet handled
  function noteOf(k) {
    const note = read().notes?.[k];
    return note?.out ? { kind: note.kind, line: note.line, at: note.at } : null;
  }

  // settleNote runs in the terminal's lane already (as ring does); noteHandled queues it
  // there; seen: you wrote or tapped in that room
  return { fillLatest, latestOf, noteOf, notesStale, overviewSent, ring, seen, settleNote: settle, noteHandled: settleLater };
}
