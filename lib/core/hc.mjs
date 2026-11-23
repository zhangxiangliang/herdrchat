// Thin wrapper over the hc CLI. Every call names its session (HC_SESSION),
// never the default core.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

// The bot runs in an hc terminal itself. Called with that terminal's identity, hc would
// wrap what the bot types in <hc from="tN"> tags, as a note from another agent; without
// it the text arrives as if you typed it.
const { HC_TERMINAL_ID, HC_SCOPE, HC_TERMINAL_SOCKET, ...ENV } = process.env;

// `herdrchat start` passes hc's full path: the core that runs the bot may have a PATH
// without it, and a bot that cannot run hc sees nothing.
const HC = process.env.HERDRCHAT_HC || 'hc';

export function hc(session, args, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      HC,
      args,
      { env: { ...ENV, HC_SESSION: session }, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          err.message = `hc ${args.join(' ')}: ${(stderr || stdout || err.message).trim()}`;
          reject(err);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

async function json(session, args) {
  return JSON.parse(await hc(session, [...args, '--json']));
}

// The machines a session is connected to: [{name, state}], state "connected" when up.
export async function machines(session) {
  return (await json(session, ['ls'])).machines || [];
}

// The id of a session's own core, and the cores it is connected to as machines:
// { self, links: [{ name, id, state }] }. A link's id is the id of the core it reaches.
export async function cores(session) {
  const [status, list] = await Promise.all([json(session, ['server', 'status']), json(session, ['machine', 'ls'])]);
  return {
    self: status.core?.id || null,
    links: (list.machines || []).map(({ name, id, state }) => ({ name, id, state })),
  };
}

export async function getTerminal(session, address) {
  return json(session, ['get', address]);
}

// `where` is "<space> / <tab>", set by herdr-app on every terminal it shows.
export function splitWhere(where) {
  const i = (where || '').indexOf(' / ');
  if (i < 0) return null;
  return { space: where.slice(0, i), tab: where.slice(i + 3) };
}

// on: a machine reached over a link; no cwd: hc's own (there, that machine's home)
export function run(session, { name, cwd, on, labels = {}, argv }) {
  const args = ['run', '--bg', '--no-parent', '--json', ...(name ? ['--name', name] : []), ...(cwd ? ['--cwd', cwd] : []), ...(on ? ['--on', on] : [])];
  for (const [k, v] of Object.entries(labels)) args.push('--label', `${k}=${v}`);
  args.push('--', ...argv);
  return hc(session, args, { timeoutMs: 30000 });
}

// force: type even when the program is blocked on a dialog (it answers the dialog).
// hc holds a send while the input box has a draft, up to its draft_wait (60 s unless set)
// after the last key there, so this waits well past that.
export const SEND_TIMEOUT_MS = 180 * 1000;
export function send(session, address, text, { force = false } = {}) {
  // `--`: what you typed is never taken for an option, even when it starts with "-"
  const args = ['send', ...(force ? ['--force'] : []), address, '--', text];
  return hc(session, args, { timeoutMs: SEND_TIMEOUT_MS });
}

// Sends a local file beside a terminal, on its machine; returns where it landed there.
export async function put(session, address, file) {
  return JSON.parse(await hc(session, ['put', address, file, '--json'], { timeoutMs: 60000 })).path;
}

// Sets labels on a terminal ({key: value}; an empty value takes the label away).
export function label(session, address, labels) {
  return hc(session, ['label', address, ...Object.entries(labels).map(([k, v]) => `${k}=${v}`)]);
}

export function keys(session, address, names) {
  return hc(session, ['keys', address, ...names]);
}

function read(session, address, lines = 0) {
  return hc(session, ['read', address, '--lines', String(lines)]);
}

// The last `lines` lines of a terminal's screen (dialogs, and replies in a terminal with no agent).
export async function screenTail(session, address, lines) {
  const out = await read(session, address, lines);
  // hc's own notes ("[hc] incomplete: older output may be missing") are not the screen
  return out.split('\n').filter((l) => !l.startsWith('[hc] ')).slice(-lines).join('\n').trimEnd();
}

// hc could not reach the machine a terminal is on (`"kind":"unavailable"`).
export function isUnavailable(err) {
  return /"kind":"unavailable"/.test(err?.message || '');
}

// The hc sessions on this machine, from hc's own folder (asking hc about a session that
// does not exist would start one: a typo must not make a session).
export const hcStateRoot = (env = process.env) => path.join(env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'herdr-core');
export function sessionsHere() {
  try {
    return fs.readdirSync(hcStateRoot(), { withFileTypes: true }).filter((d) => d.isDirectory() && fs.existsSync(path.join(hcStateRoot(), d.name, 'core.json'))).map((d) => d.name).sort();
  } catch {
    return [];
  }
}

// Whether a session's hc core runs, without starting it: its socket (named in core.lock)
// takes a connection.
export function coreUp(session, timeoutMs = 1000) {
  let socket;
  try {
    socket = fs.readFileSync(path.join(hcStateRoot(), session, 'core.lock'), 'utf8').trim().split('\n')[0];
  } catch {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const c = net.connect(socket);
    const done = (up) => { c.destroy(); resolve(up); };
    c.once('connect', () => done(true));
    c.once('error', () => done(false));
    setTimeout(() => done(false), timeoutMs);
  });
}

// A failed hc call as a person reads it: hc's own message, without the command line or
// its JSON wrapping.
export function plainError(err) {
  const raw = err?.message || String(err);
  const json = raw.match(/\{"error":.*\}\s*$/);
  if (json) {
    try {
      const { message, kind } = JSON.parse(json[0]).error;
      if (kind === 'finished') return 'this terminal has ended.';
      if (message) return message;
    } catch {
      // not hc's JSON
    }
  }
  return raw.replace(/^hc [^:]*: /, '');
}

// A screen as people read it: no trailing spaces, no blank lines at the ends, never two
// blank lines in a row; with `last`, only its last `last` lines (a dialog sits at the bottom).
export function tidyScreen(text, last = Infinity) {
  const lines = [];
  for (const line of (text || '').split('\n').map((l) => l.trimEnd())) {
    if (!line && (!lines.length || !lines[lines.length - 1])) continue;
    lines.push(line);
  }
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  return lines.slice(-last).join('\n');
}

// What a screen shows that it did not before, both tidied. Lined up from the bottom: an
// agent may draw its history again (another width, a redraw), so only the last lines of
// `before` are looked for in `now`. A few lines from near its end (with words in them) are
// found in `now`, the last place they are; what follows them is new when it is more than
// followed them before (what stays at the bottom, as an input box, follows them both
// times). The window starts at the very end and moves up past what changed there (a
// status line, a box drawn at another width). null when nothing lines up or nothing is
// new, so the caller shows the screen's tail instead.
const WINDOW = 3;
const SEARCH_UP = 25;
export function newOnScreen(before, now) {
  const old = (before || '').split('\n');
  const lines = (now || '').split('\n');
  for (let end = old.length; end >= Math.max(WINDOW, old.length - SEARCH_UP); end -= 1) {
    const window = old.slice(end - WINDOW, end);
    if (window.filter((l) => /\w/.test(l)).length < 2) continue;
    let at = -1;
    for (let i = lines.length - WINDOW; i >= 0; i -= 1) {
      if (window.every((l, j) => lines[i + j] === l)) { at = i; break; }
    }
    if (at < 0) continue;
    const after = lines.slice(at + WINDOW);
    if (after.length <= old.length - end) continue; // no more than before: nothing came in here
    return after.join('\n').replace(/^\n+/, '') || null;
  }
  return null;
}

// "machine/tN" for a terminal on a connected machine, "tN" here.
export function machineOf(address) {
  const i = address.lastIndexOf('/');
  return i < 0 ? null : address.slice(0, i);
}
