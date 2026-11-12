import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLog } from '../lib/log.mjs';

test('the log writes one file a day with levels, and drops files past 14 days', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdrchat-log-test-'));
  const was = { log: console.log, error: console.error };
  console.log = () => {};
  console.error = () => {};
  try {
    fs.writeFileSync(path.join(dir, '2000-01-01.log'), 'old\n');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a log\n');
    const log = createLog(dir);
    log.info('hello');
    log.info('two\nlines');
    log.error('broke', new Error('boom'));
    const today = new Date().toISOString().slice(0, 10);
    const text = fs.readFileSync(path.join(dir, `${today}.log`), 'utf8');
    assert.match(text, / INFO hello\n/);
    assert.match(text, / INFO two ⏎ lines\n/);
    assert.match(text, / ERROR broke Error: boom\n {4}at /);
    assert.equal(fs.existsSync(path.join(dir, '2000-01-01.log')), false);
    assert.equal(fs.existsSync(path.join(dir, 'notes.txt')), true);
  } finally {
    Object.assign(console, was);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
