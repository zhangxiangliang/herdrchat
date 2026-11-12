// Thin wrapper over the hc CLI. Every call names its session (HC_SESSION),
// never the default core.
import { execFile } from 'node:child_process';

// The bot runs in an hc terminal itself. Called with that terminal's identity, hc would
// wrap what the bot types in <hc from="tN"> tags, as a note from another agent; without
// it the text arrives as if you typed it.
const { HC_TERMINAL_ID, HC_SCOPE, HC_TERMINAL_SOCKET, ...ENV } = process.env;

export function hc(session, args, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      'hc',
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

// The last `lines` lines of a terminal's screen: the default output for a program with no reader.
export async function screenTail(session, address, lines) {
  const out = await read(session, address, lines);
  return out.split('\n').slice(-lines).join('\n').trimEnd();
}

// "machine/tN" for a terminal on a connected machine, "tN" here.
export function machineOf(address) {
  const i = address.lastIndexOf('/');
  return i < 0 ? null : address.slice(0, i);
}
