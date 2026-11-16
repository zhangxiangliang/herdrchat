// The overview's shape, the same for every chat app (each draws it its own way): the rooms
// with a note not handled yet first ("waiting for you": what rang, engine/notes.mjs), then
// every terminal as herdr-app's sidebar has it: by machine (this computer first), then by
// space, each space one line of its tabs. A row is the core's {name, address, state, kind,
// program, since, room, note?}; its name is "<space> / <tab>".
import { byNote } from '../core/words.mjs';

const machineOf = (address) => {
  const i = String(address || '').lastIndexOf('/');
  return i < 0 ? null : address.slice(0, i);
};
const split = (name) => {
  const i = name.indexOf(' / ');
  return i < 0 ? { space: name, tab: '' } : { space: name.slice(0, i), tab: name.slice(i + 3) };
};

// -> {waiting: rows (needs you before done, the newest first), machines: [{machine: null
// (this computer) | name, spaces: [{space, tabs: [{...row, tab}]}]}]}, spaces and tabs by name
export function groupsOf(rows) {
  const waiting = rows.filter((r) => r.note).sort(byNote);
  const machines = new Map();
  for (const r of rows) {
    const m = machineOf(r.address);
    const { space, tab } = split(r.name);
    if (!machines.has(m)) machines.set(m, new Map());
    const spaces = machines.get(m);
    if (!spaces.has(space)) spaces.set(space, []);
    spaces.get(space).push({ ...r, tab: tab || r.name });
  }
  const byName = (a, b) => a.localeCompare(b);
  return {
    waiting,
    machines: [...machines.keys()].sort((a, b) => (a === null ? -1 : b === null ? 1 : byName(a, b))).map((machine) => ({
      machine,
      spaces: [...machines.get(machine).keys()].sort(byName).map((space) => ({ space, tabs: machines.get(machine).get(space).sort((a, b) => byName(a.tab, b.tab)) })),
    })),
  };
}

// The one mark a tab gets in its space's line: what moves. Done and idle both wait for
// your next word, so they get none.
const MARKS = { blocked: '⚠️', working: '⏳', error: '🔴' };
export const markOf = (row) => MARKS[row.state] || '';
