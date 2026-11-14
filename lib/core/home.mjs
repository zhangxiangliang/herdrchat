// Files under the home folder of the machine a terminal runs on: read here, or through
// `hc exec --on <machine>` for a terminal on a connected machine (cwd there is home).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hc } from './hc.mjs';
import { itemsAfter } from './cursor.mjs';

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

// The items after `cursor` in a .jsonl log: its tail first, the whole file when the tail
// does not reach back to the cursor.
export async function logAfter(session, machine, rel, cursor, entryItems) {
  const tail = itemsAfter((await homeFile(session, machine, rel, { tail: TAIL_LINES })).split('\n'), cursor, entryItems);
  if (tail.complete) return tail.items;
  return itemsAfter((await homeFile(session, machine, rel)).split('\n'), cursor, entryItems).items;
}
