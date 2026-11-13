import assert from 'node:assert/strict';
import test from 'node:test';
import { machineOf, splitWhere } from '../lib/core/hc.mjs';

test('splitWhere', () => {
  assert.deepEqual(splitWhere('alpha / 2'), { space: 'alpha', tab: '2' });
  assert.deepEqual(splitWhere('a / b / c'), { space: 'a', tab: 'b / c' });
  assert.equal(splitWhere(undefined), null);
});

test('machineOf', () => {
  assert.equal(machineOf('t37'), null);
  assert.equal(machineOf('box/t4t'), 'box');
});

test('what you type is sent after --, so a message starting with "-" is never taken for an option', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdrchat-hc-send-'));
  const stub = path.join(dir, 'hc');
  const out = path.join(dir, 'args');
  fs.writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(out)}\n`, { mode: 0o755 });
  const before = process.env.HERDRCHAT_HC;
  process.env.HERDRCHAT_HC = stub;
  try {
    const { send } = await import(`../lib/core/hc.mjs?stub=${Date.now()}`);
    await send('s', 't1', '- a list item');
    assert.deepEqual(fs.readFileSync(out, 'utf8').trim().split('\n'), ['send', 't1', '--', '- a list item']);
    await send('s', 't1', '--force', { force: true });
    assert.deepEqual(fs.readFileSync(out, 'utf8').trim().split('\n'), ['send', '--force', 't1', '--', '--force']);
  } finally {
    if (before === undefined) delete process.env.HERDRCHAT_HC;
    else process.env.HERDRCHAT_HC = before;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
