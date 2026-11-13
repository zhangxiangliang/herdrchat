// Thin wrapper over the hc CLI. Every call names its session (HC_SESSION),
// never the default core.
import { execFile } from 'node:child_process';

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

export function run(session, { name, cwd, labels = {}, argv }) {
  const args = ['run', '--bg', '--no-parent', '--json', ...(name ? ['--name', name] : []), '--cwd', cwd];
  for (const [k, v] of Object.entries(labels)) args.push('--label', `${k}=${v}`);
  args.push('--', ...argv);
  return hc(session, args, { timeoutMs: 30000 });
}

// force: type even when the program is blocked on a dialog (it answers the dialog).
export function send(session, address, text, { force = false } = {}) {
  const args = ['send', ...(force ? ['--force'] : []), address, text];
  return hc(session, args, { timeoutMs: 60000 });
}

// Sends a local file beside a terminal, on its machine; returns where it landed there.
export async function put(session, address, file) {
  return JSON.parse(await hc(session, ['put', address, file, '--json'], { timeoutMs: 60000 })).path;
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
  return out.split('\n').slice(-lines).join('\n').trimEnd();
}

// hc could not reach the machine a terminal is on (`"kind":"unavailable"`).
export function isUnavailable(err) {
  return /"kind":"unavailable"/.test(err?.message || '');
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

// "machine/tN" for a terminal on a connected machine, "tN" here.
export function machineOf(address) {
  const i = address.lastIndexOf('/');
  return i < 0 ? null : address.slice(0, i);
}
