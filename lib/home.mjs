// Files under the home folder of the machine a terminal runs on: read here, or through
// `hc exec --on <machine>` for a terminal on a connected machine (cwd there is home).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hc } from './hc.mjs';
import { itemsAfter } from './cursor.mjs';

const TAIL_LINES = 1500;

export async function homeFile(session, machine, rel, { tail } = {}) {
  if (!machine) {
    const text = fs.readFileSync(path.join(os.homedir(), rel), 'utf8');
    return tail ? text.split('\n').slice(-tail).join('\n') : text;
  }
  const argv = tail ? ['tail', '-n', String(tail), rel] : ['cat', rel];
  return hc(session, ['exec', '--on', machine, ...argv], { timeoutMs: 30000 });
}

// The items after `cursor` in a .jsonl log: its tail first, the whole file when the tail
// does not reach back to the cursor.
export async function logAfter(session, machine, rel, cursor, entryItems) {
  const tail = itemsAfter((await homeFile(session, machine, rel, { tail: TAIL_LINES })).split('\n'), cursor, entryItems);
  if (tail.complete) return tail.items;
  return itemsAfter((await homeFile(session, machine, rel)).split('\n'), cursor, entryItems).items;
}
