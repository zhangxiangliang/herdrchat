// Files under the home folder of the machine a terminal runs on: read here, or through
// `hc exec --on <machine>` for a terminal on a connected machine (cwd there is home).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hc } from './hc.mjs';
import { itemsAfter } from './cursor.mjs';
import { shellQuote } from './shell.mjs';

const TAIL_LINES = 1500;

// `rel` is relative to home, or a full path.
export async function homeFile(session, machine, rel, { tail } = {}) {
  if (!machine) {
    const text = fs.readFileSync(path.isAbsolute(rel) ? rel : path.join(os.homedir(), rel), 'utf8');
    return tail ? text.split('\n').slice(-tail).join('\n') : text;
  }
  const argv = tail ? ['tail', '-n', String(tail), rel] : ['cat', rel];
  return hc(session, ['exec', '--on', machine, ...argv], { timeoutMs: 30000 });
}

// A short shell command in the home folder of the machine a terminal runs on: here, or
// through `hc exec --on <machine>`. Its output; empty when it fails.
export async function homeShell(session, machine, script) {
  if (!machine) {
    const { execFile } = await import('node:child_process');
    return new Promise((resolve) => execFile('sh', ['-c', script], { cwd: os.homedir(), timeout: 30000 }, (err, stdout) => resolve(err && !stdout ? '' : String(stdout))));
  }
  return hc(session, ['exec', '--on', machine, 'sh', '-c', script], { timeoutMs: 30000 }).catch(() => '');
}

// A log that is not there (here: ENOENT; through hc exec: cat's "No such file").
export const noSuchFile = (err) => /ENOENT|No such file/.test(err?.message || '');

// The items after `cursor` in a .jsonl log: its tail first, the whole file when the tail
// does not reach back to the cursor. On another machine by bytes, not lines (logTail).
export async function logAfter(session, machine, rel, cursor, entryItems, { piece } = {}) {
  if (machine) return remoteLogAfter(session, machine, rel, cursor, entryItems, piece);
  const tail = itemsAfter((await homeFile(session, machine, rel, { tail: TAIL_LINES })).split('\n'), cursor, entryItems);
  if (tail.complete) return tail.items;
  return itemsAfter((await homeFile(session, machine, rel)).split('\n'), cursor, entryItems).items;
}

// `hc exec` passes back the first 8 MB of what a command prints and cuts the rest, and a
// log's last lines can be more than that (an image an agent looked at is a line of base64),
// so the newest of them, the ones wanted, were cut. On another machine a log is read by its
// last bytes instead, in pieces of PIECE_BYTES, each cut after its last whole line (so no
// line, and no character, is split): the last TAIL_BYTES first, four times as many until
// they reach back to the cursor or are the whole file.
const PIECE_BYTES = 4 * 1024 * 1024;
const TAIL_BYTES = 2 * 1024 * 1024;
async function remoteLogAfter(session, machine, rel, cursor, entryItems, piece = PIECE_BYTES) {
  const size = parseInt(await hc(session, ['exec', '--on', machine, 'sh', '-c', `wc -c < ${shellQuote(rel)}`], { timeoutMs: 30000 }), 10);
  if (!Number.isFinite(size)) throw new Error(`${rel}: its size is not known`);
  for (let bytes = Math.min(TAIL_BYTES, size); ; bytes = Math.min(bytes * 4, size)) {
    const found = itemsAfter(await logTail(session, machine, rel, size, bytes, piece), cursor, entryItems);
    if (found.complete || bytes >= size) return found.items;
  }
}

// The lines of the last `bytes` of a file `size` bytes long on another machine, read a
// piece at a time; a first line the start cuts is left out, and so is a line longer than a
// piece (it cannot come back whole).
export async function logTail(session, machine, rel, size, bytes, piece = PIECE_BYTES) {
  let pos = Math.max(1, size - bytes + 1); // tail -c +N counts from 1
  let cut = pos > 1;
  const lines = [];
  while (pos <= size) {
    const text = await hc(session, ['exec', '--on', machine, 'sh', '-c', `tail -c +${pos} ${shellQuote(rel)} | head -c ${piece}`], { timeoutMs: 60000 });
    const last = pos + piece > size;
    const end = last ? text.length : text.lastIndexOf('\n') + 1;
    if (!end) {
      // no whole line in a piece: that line is left out, and so is what of it the next starts with
      pos += piece;
      cut = true;
      continue;
    }
    const part = text.slice(0, end);
    const got = part.split('\n');
    if (cut) got.shift();
    cut = false;
    lines.push(...got);
    pos += Buffer.byteLength(part);
    if (last) break;
  }
  return lines;
}
