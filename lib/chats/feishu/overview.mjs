// The overview: one card in the direct chat with the bot, laid out as herdr-app's sidebar
// (lib/chats/overview.mjs): first what is waiting for you (a note not handled yet: what
// rang, engine/notes.mjs) as a table (notesTable); then a heading per machine (this
// computer first, all its sessions) and its table (groupTable): a row per tab, a link that
// opens its group, its state, its latest line.
// It is edited in place, which never rings; sent anew when a note rings, its summary (the
// lock screen) says what for. One a newer one replaced is the record of what it rang for,
// in full, a few lines a note: the history, not an overview (recordCard).
import { entities, header, newButton } from './render.mjs';
import { groupsOf } from '../overview.mjs';
import * as words from '../../core/words.mjs';

const chatLink = (chat) => `https://applink.feishu.cn/client/chat/open?openChatId=${chat}`;
const clock = (ms) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const cut = (text) => (text.length > 160 ? `${text.slice(0, 159)}…` : text);
const link = (room, text) => (room ? `[${entities(text)}](${chatLink(room)})` : entities(text));

// Every table here has the same three columns (card JSON 2.0 `table`): the room ("space /
// tab", a link to its group), its state as a colored tag, and the latest: the first line of
// what it said, after the time it said it ("11:49: Fixed it."), cut by the client and shown
// whole on a tap. Feishu shows an empty cell as "--", so one is left empty only when
// nothing is known. A cell wraps to a second line (on a phone a column is a third of a
// narrow card: one line showed "tw-worker / ..." for every room). A card holds at most
// TABLES tables and a table shows ROWS rows a page; with more machines than that, the
// smallest share one table.
// rows: [{name, room, state: {text, color}, latest}]
const TABLES = 5;
const ROWS = 10;
// two lines of text and the cell's padding (row_height auto: Feishu 7.33 or later)
const ROW_MAX_HEIGHT = '64px';
const LINE_CHARS = 120;
const short = (text) => (text && text.length > LINE_CHARS ? `${text.slice(0, LINE_CHARS - 1)}…` : text || '');
const mdLink = (room, text) => {
  const shown = text.replace(/[[\]]/g, '');
  return room ? `[${shown}](${chatLink(room)})` : shown;
};
function roomsTable(rows) {
  return {
    tag: 'table',
    page_size: ROWS,
    row_height: 'auto',
    row_max_height: ROW_MAX_HEIGHT,
    header_style: { background_style: 'grey', text_color: 'grey', bold: true },
    columns: [
      { name: 'room', display_name: words.COL_ROOM, data_type: 'lark_md', width: 'auto' },
      { name: 'state', display_name: words.COL_STATE, data_type: 'options', width: 'auto' },
      { name: 'latest', display_name: words.COL_LATEST, data_type: 'text', width: 'auto' },
    ],
    rows: rows.map((r) => ({ room: mdLink(r.room, r.name), state: [r.state], latest: short(r.latest) })),
  };
}

// A note in an old overview's record, in full (a record is the history of what rang, read
// for its details, not an overview): what it is as a colored tag (grey once handled), the
// room, when; its line under it, grey; once handled, how and when.
// A name's marks are HTML entities (client.mjs). A text_tag is not markdown: it shows its
// text as it is, entities and backslashes too, so only what would end the tag goes.
const tagText = (text) => text.replace(/[<>]/g, '');
function noteLines(note) {
  const color = note.handled ? 'neutral' : NOTE_COLORS[note.kind] || 'neutral';
  const lines = [`<text_tag color='${color}'>${tagText(words.noteWord(note))}</text_tag> **${link(note.room, note.name)}** · ${clock(note.at)}`];
  if (note.line) lines.push(`<font color='grey'>${entities(note.line)}</font>`);
  if (note.handled) lines.push(`<font color='grey'>${entities(words.noteHandled(note.handled))}</font>`);
  return lines;
}

// A note's state in "waiting for you": what it is (needs you, done).
// notes: [{kind, name, room, at, line, handled?}]
const NOTE_COLORS = { needs: 'orange', done: 'green' };
const noteState = (n) => ({ text: words.noteWord(n), color: NOTE_COLORS[n.kind] || 'neutral' });
const notesTable = (notes) => roomsTable(notes.map((n) => ({ name: n.name, room: n.room, state: noteState(n), latest: words.latestText(n.line, n.at) })));

// A tab's state: its hc status (grey when idle; with no agent, the program it runs).
const STATE_COLORS = { blocked: 'orange', working: 'blue', done: 'green', error: 'red', idle: 'neutral' };
const tabState = (t) => ({ text: t.state === 'blocked' ? words.noteWord({ kind: 'needs' }) : words.stateWord(t), color: STATE_COLORS[t.state] || 'neutral' });
// its tabs, what needs you first (lib/chats/overview.mjs, byUrgency)
const groupTable = (tabs) => roomsTable(tabs.map((t) => ({ name: t.name, room: t.room, state: tabState(t), latest: words.latestText(t.latest, t.latestAt) })));

// The card's body: "waiting for you", then per machine a heading and its table.
// rows: [{name, address, state, kind, program, since, room, latest, latestAt, note?}];
// state is the hc status word, or none.
export function overviewElements(rows) {
  if (!rows.length) return [{ tag: 'markdown', content: words.NO_TERMINALS }];
  const { waiting, groups } = groupsOf(rows);
  const elements = [];
  if (waiting.length) {
    elements.push({ tag: 'markdown', content: `### ${words.WAITING_FOR_YOU}` });
    elements.push(notesTable(waiting.map((r) => ({ ...r.note, name: r.name, room: r.room }))));
  }
  // the tables a card holds, "waiting for you" first; past them the smallest groups (the
  // later of two the same size) share one, where the first of them is: its heading names
  // them all, a group's rooms after another's
  const over = groups.length - (TABLES - (waiting.length ? 1 : 0));
  const shared = new Set(over > 0 ? groups.map((g, i) => [g.tabs.length, i]).sort((a, b) => a[0] - b[0] || b[1] - a[1]).slice(0, over + 1).map(([, i]) => i) : []);
  const title = (g) => g.name || words.THIS_COMPUTER;
  groups.forEach((g, i) => {
    if (!shared.has(i)) {
      elements.push({ tag: 'markdown', content: `### ${entities(title(g))}` }, groupTable(g.tabs));
      return;
    }
    if (i !== Math.min(...shared)) return;
    const together = groups.filter((_, j) => shared.has(j));
    elements.push({ tag: 'markdown', content: `### ${entities(together.map(title).join(' · '))}` }, groupTable(together.flatMap((x) => x.tabs)));
  });
  return elements;
}
// what the card says, to tell an edit that would change nothing
export const overviewText = (rows) => JSON.stringify(overviewElements(rows));

// `hint`: a small line at the bottom. Under the tables, the button that sends the
// new-terminal form (lib/core/engine/create.mjs).
export function overviewCard(rows, now, { hint = '' } = {}) {
  const waiting = rows.filter((r) => r.state === 'blocked').length;
  const working = rows.filter((r) => r.state === 'working').length;
  const tone = waiting || rows.some((r) => r.note?.kind === 'needs') ? 'needs' : working ? 'working' : 'good';
  const title = words.overviewTitle(waiting, rows.length);
  // the newest note not handled yet is what the lock screen and the chat list say
  const newest = rows.filter((r) => r.note).sort((a, b) => b.note.at - a.note.at)[0];
  return {
    schema: '2.0',
    config: { update_multi: true, summary: { content: cut(newest ? words.noteSummary({ ...newest.note, name: newest.name }) : title) } },
    header: header(title, tone),
    body: { elements: [...overviewElements(rows), newButton(words.NEW_BUTTON), { tag: 'markdown', content: words.updatedAt(clock(now)), text_size: 'notation' }, ...(hint ? [{ tag: 'markdown', content: entities(hint), text_size: 'notation' }] : [])] },
  };
}

// An overview a newer one replaced (engine/notes.mjs): what it rang for, one note each as
// "waiting for you" has it, each saying how it was handled once it is; with nothing, that
// it is an old overview. Edited, never recalled.
export function recordCard(notes) {
  const summary = notes.length ? words.noteSummary(notes[0]) : words.OLD_OVERVIEW;
  const content = notes.length ? notes.flatMap(noteLines).join('\n') : entities(words.OLD_OVERVIEW);
  return { schema: '2.0', config: { update_multi: true, summary: { content: cut(summary) } }, body: { elements: [{ tag: 'markdown', content }] } };
}
