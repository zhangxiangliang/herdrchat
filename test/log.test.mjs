import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLog } from '../lib/core/log.mjs';

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

test('a crash is written and onCrash runs before the process exits', async () => {
  const { execFile } = await import('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdrchat-crash-test-'));
  const said = path.join(dir, 'said');
  const script = `
    import fs from 'node:fs';
    import { createLog } from ${JSON.stringify(path.resolve('lib/core/log.mjs'))};
    const log = createLog(${JSON.stringify(dir)});
    log.capture({ onCrash: async (err) => { await new Promise((r) => setTimeout(r, 100)); fs.writeFileSync(${JSON.stringify(said)}, err.message); } });
    setTimeout(() => { throw new Error('boom'); }, 0);
  `;
  const code = await new Promise((resolve) => {
    execFile(process.execPath, ['--input-type=module', '-e', script], (err) => resolve(err ? err.code : 0));
  });
  assert.equal(code, 1);
  assert.equal(fs.readFileSync(said, 'utf8'), 'boom');
  const text = fs.readFileSync(path.join(dir, `${new Date().toISOString().slice(0, 10)}.log`), 'utf8');
  assert.match(text, / ERROR uncaught: Error: boom/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a library error printed as a plain log line is logged as WARN', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdrchat-log-level-'));
  const realLog = console.log;
  try {
    const log = createLog(dir);
    log.capture();
    console.log('[error]:', ['[ws]', 'connect failed']);
    console.log('[feishu] connected');
  } finally {
    console.log = realLog;
  }
  const text = fs.readFileSync(path.join(dir, `${new Date().toISOString().slice(0, 10)}.log`), 'utf8');
  assert.match(text, / WARN \[error\]:/);
  assert.match(text, / INFO \[feishu\] connected/);
  fs.rmSync(dir, { recursive: true, force: true });
});
