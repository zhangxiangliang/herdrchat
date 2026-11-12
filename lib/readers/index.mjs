// Readers: how the bot gets what an agent said from the agent's own records, so nothing
// is lost and the group shows it while the agent works. hc stays the backbone (which
// terminals exist, their status, when a turn ends, typing into them); a reader adds the
// conversation. A program with no reader gets the default: its screen through `hc read`.
//
// A reader is a module that exports:
//   app                              the name the agent gives in its hc status (`status.app`)
//   after(session, address, cursor)  -> {items, file} | null: what is new since `cursor`
//                                       (null: this terminal is not readable); `file` is
//                                       the log it read, kept in the cursor
//   rest(session, address, cursor)   -> items: what `cursor.file` still holds after the
//                                       program is gone
// Items are {role: 'you' | 'ai' | 'tool', text, at, id, end?} (`end` marks the turn's last
// answer) or {role: 'image', from: 'you' | 'ai', media, data (base64), at, id}.
// Cursors are in ../cursor.mjs.
//
// To add an agent: write lib/readers/<agent>.mjs and list it here.
import * as claude from './claude.mjs';

const READERS = new Map([claude].map((r) => [r.app, r]));

export function readerFor(app) {
  return READERS.get(app) || null;
}
