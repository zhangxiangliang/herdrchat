// Readers: how the bot gets what an agent said from the agent's own records, so nothing
// is lost and the group shows it while the agent works. hc stays the backbone (which
// terminals exist, their status, when a turn ends, typing into them); a reader adds the
// conversation. A terminal with no running agent is not mirrored (see agentOf).
//
// A reader is a module that exports:
//   app                              the name the agent gives in its hc status (`status.app`)
//   processes                        the names its process runs under (hc's `foreground`)
//   after(session, address, cursor)  -> {items, file} | null: what is new since `cursor`
//                                       (null: this terminal is not readable); `file` is
//                                       the log it read, kept in the cursor
//   rest(session, address, cursor)   -> items: what `cursor.file` still holds after the
//                                       program is gone
//   titleOf(title)                   (optional) the room's name from the terminal's title,
//                                       when the agent's title holds more than a name
//   dialog(session, address)         (optional) what it waits on, from the agent itself (its
//                                       API, or herdrchat's hook: ../asks.mjs): {key, kind,
//                                       title, text, options, multi, free, ref}; null when
//                                       nothing; false when it cannot tell there (no hook on
//                                       that machine), so the screen is read at once.
//                                       `idle`: a question that leaves it idle (answered by
//                                       your next message); its card stays till it works
//   asksIdle                         (optional) true when its dialog can be `idle`: asked
//                                       at a turn's end and at a sweep
//   answer(session, address, shown, {pick, text, ticks, esc})
//                                    (optional) answers what `shown` (from dialog) asks;
//                                       true when the agent took it
//   leftInput(screen, sent)          (optional) when it did not take what was sent (no turn
//                                       started) and its input box still holds it: the keys
//                                       that empty the box, else null
//   short                            (optional) its name in a post's footer, when `app` is long
//   meter(session, address, meta)    (optional) for the footer, what its records do not
//                                       hold: {contextSize, limits}, from the agent itself and
//                                       never a model call; quick (last known, ../meter.mjs)
// Items are {role: 'you' | 'ai' | 'tool', text, at, id, end?} (`end` marks the turn's last
// answer), {role: 'image', from: 'you' | 'ai', media, data (base64), at, id}, or
// {role: 'meta', at, id}: never a post, only what the footer says. Any item may carry what
// its records say for the footer: `model`, `provider`, `context` ({used, size?}: tokens in
// its context, of how many) and `limits` ([{name: '5-hour', used: 2}]: percent used).
// Cursors are in ../cursor.mjs.
//
// To add an agent: write lib/core/readers/<agent>.mjs and list it in LISTED below
// (docs/architecture.md, "Adding an agent").
import path from 'node:path';
import * as claude from './claude.mjs';
import * as codex from './codex.mjs';
import * as opencode from './opencode.mjs';
import * as pi from './pi.mjs';

// What every reader exports (see above); checked for each one listed here when this
// loads, so a reader that misses one fails at start, not when its agent first runs.
export const READER_MEMBERS = { app: 'string', processes: 'object', after: 'function', rest: 'function' };
export function checkReader(reader) {
  const wrong = Object.entries(READER_MEMBERS).filter(([m, type]) => typeof reader?.[m] !== type);
  if (wrong.length) throw new Error(`reader ${reader?.app || '?'} does not give: ${wrong.map(([m]) => m).join(', ')} (lib/core/readers/index.mjs)`);
  return reader;
}

export const LISTED = [claude, codex, opencode, pi].map(checkReader);
const READERS = new Map(LISTED.map((r) => [r.app, r]));

export function readerFor(app) {
  return READERS.get(app) || null;
}

// The agent a terminal runs right now, as its reader, or null: a group mirrors agents
// only, never a shell or another program. hc's status can outlive the agent (it still
// said "blocked" after Claude quit, and a tool run after it was posted as a dialog), so
// the foreground process must be that agent too; with no foreground known, the status
// alone decides, so a terminal is never silenced for missing data.
export function agentOf(record) {
  const reader = readerFor(record?.status?.app);
  const fg = record?.foreground;
  if (!reader || !fg) return reader;
  return [fg.name, path.basename(fg.argv?.[0] || '')].some((n) => reader.processes.includes(n)) ? reader : null;
}
