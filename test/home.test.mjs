// Reading a log on another machine through `hc exec`, which passes back only so much of
// what a command prints: here a fake hc that runs the command locally and cuts its output
// at the bytes its `cap` file says, as hc does at 8 MB (a file: hc is run with the
// environment the bot started with).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdrchat-home-test-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const fake = path.join(dir, 'hc');
const cap = (bytes) => fs.writeFileSync(path.join(dir, 'cap'), String(bytes));
// hc exec --on <machine> <argv...>: run argv in `dir` (the machine's home), print at most CAP bytes
fs.writeFileSync(fake, `#!/bin/sh
shift 3
cd "${dir}" && "$@" | head -c "$(cat "${dir}/cap")"
`, { mode: 0o755 });
process.env.HERDRCHAT_HC = fake;
const { logAfter, logTail } = await import('../lib/core/home.mjs');
const { startCursor } = await import('../lib/core/cursor.mjs');

const at = (i) => new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
const line = (i, text) => JSON.stringify({ timestamp: at(i), uuid: `u${i}`, text });
const items = (entry) => [{ role: 'ai', text: entry.text }];

test('a log on another machine whose last lines are more than hc passes back: the newest are read, none cut', async () => {
  cap(3000);
  // an image's base64 makes some lines long; the newest lines come after them
  const lines = [line(1, 'old'), line(2, 'x'.repeat(2500)), line(3, 'y'.repeat(2500)), line(4, '你好，最新的回答'), line(5, 'the last one')];
  fs.writeFileSync(path.join(dir, 'a.jsonl'), `${lines.join('\n')}\n`);
  const got = await logAfter('s', 'box', 'a.jsonl', startCursor(at(1)), items, { piece: 2800 });
  assert.deepEqual(got.map((it) => it.text.slice(0, 20)), ['x'.repeat(20), 'y'.repeat(20), '你好，最新的回答', 'the last one']);
});

test('pieces are cut after their last whole line, so no line and no character is split', async () => {
  cap(100000);
  const lines = Array.from({ length: 40 }, (_, i) => line(i + 1, `第${i}行 ${'中'.repeat(i % 7)}`));
  fs.writeFileSync(path.join(dir, 'b.jsonl'), `${lines.join('\n')}\n`);
  const size = fs.statSync(path.join(dir, 'b.jsonl')).size;
  const read = (await logTail('s', 'box', 'b.jsonl', size, size, 97)).filter(Boolean);
  assert.deepEqual(read, lines);
});

test('a line longer than a piece is left out, and what follows it is still read', async () => {
  cap(100000);
  const lines = [line(1, 'a'), line(2, 'z'.repeat(500)), line(3, 'after it')];
  fs.writeFileSync(path.join(dir, 'c.jsonl'), `${lines.join('\n')}\n`);
  const size = fs.statSync(path.join(dir, 'c.jsonl')).size;
  const read = (await logTail('s', 'box', 'c.jsonl', size, size, 120)).filter(Boolean);
  assert.deepEqual(read, [lines[0], lines[2]]);
});
