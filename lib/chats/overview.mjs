// The overview's shape, the same for every chat app (each draws it its own way): the rooms
// with a note not handled yet first ("waiting for you": what rang, engine/notes.mjs), then
// every terminal by session (HERDR_SESSIONS, in its order), a machine reached over a link
// a group of its own after them, then by space, each space one line of its tabs. A row is
// the core's {name, address, session, state, kind, program, since, room, note?}; its name
// is "<space> / <tab>".
import { byNote } from '../core/words.mjs';

const machineOf = (address) => {
  const i = String(address || '').lastIndexOf('/');
  return i < 0 ? null : address.slice(0, i);
};
const split = (name) => {
  const i = name.indexOf(' / ');
  return i < 0 ? { space: name, tab: '' } : { space: name.slice(0, i), tab: name.slice(i + 3) };
};

// What needs you comes first: needs you, then an error, working, done, and idle or no
// agent last; within one state the one that spoke last first, then by name.
const RANK = { blocked: 0, error: 1, working: 2, done: 3, idle: 4 };
const rankOf = (row) => RANK[row.state] ?? 5;
export const byUrgency = (a, b) => rankOf(a) - rankOf(b) || (b.latestAt || 0) - (a.latestAt || 0) || a.name.localeCompare(b.name);

// -> {waiting: rows (needs you before done, the newest first), groups: [{name: the session,
// or the machine (remote); null: this computer, when it is the only session, tabs: every
// tab of it, what needs you first (byUrgency), spaces: [{space, tabs: [{...row, tab}]}], a
// space by its most urgent tab, its tabs the same way}]}. A tab's `tab` is its own name,
// and `short` what a group's list calls it: the tab alone in a space named as the group
// (takewalks / master under "takewalks": master), else the whole name.
export function groupsOf(rows) {
  const waiting = rows.filter((r) => r.note).sort(byNote);
  const groups = new Map();
  for (const r of rows) {
    const machine = machineOf(r.address);
    const id = machine ? `@${machine}` : r.session || '';
    if (!groups.has(id)) groups.set(id, { name: machine || r.session || null, remote: Boolean(machine), spaces: new Map() });
    const { space, tab } = split(r.name);
    const { spaces } = groups.get(id);
    if (!spaces.has(space)) spaces.set(space, []);
    spaces.get(space).push({ ...r, tab: tab || r.name });
  }
  const byName = (a, b) => a.localeCompare(b);
  const all = [...groups.values()];
  const here = all.filter((g) => !g.remote);
  // a session alone is this computer, as herdr-app says it
  if (here.length === 1) here[0].name = null;
  return {
    waiting,
    // sessions as the rows come (in HERDR_SESSIONS's order), then machines by name
    groups: [...here, ...all.filter((g) => g.remote).sort((a, b) => byName(a.name, b.name))].map(({ name, spaces: map }) => {
      const spaces = [...map].map(([space, tabs]) => ({ space, tabs: tabs.sort(byUrgency).map((t) => ({ ...t, short: name && space === name && t.tab !== t.name ? t.tab : t.name })) }))
        .sort((a, b) => byUrgency(a.tabs[0], b.tabs[0]) || byName(a.space, b.space));
      return { name, tabs: spaces.flatMap((s) => s.tabs).sort(byUrgency), spaces };
    }),
  };
}

// The one mark a tab gets in its space's line: what moves. Done and idle both wait for
// your next word, so they get none.
const MARKS = { blocked: '⚠️', working: '⏳', error: '🔴' };
export const markOf = (row) => MARKS[row.state] || '';
