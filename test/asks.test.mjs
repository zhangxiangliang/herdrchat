// Whether a hook's request is still open, asked of a machine through `hc exec`: here a fake
// hc that runs the command in `dir` (the machine's home), with real processes for hooks.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdrchat-asks-test-'));
const procs = [];
after(() => {
  for (const p of procs) p.kill();
  fs.rmSync(dir, { recursive: true, force: true });
});
const fake = path.join(dir, 'hc');
// hc exec --on <machine> <argv...>: run argv in `dir`
fs.writeFileSync(fake, `#!/bin/sh
shift 3
cd "${dir}" && "$@"
`, { mode: 0o755 });
process.env.HERDRCHAT_HC = fake;
const { askOpen, strayAsks } = await import('../lib/core/asks.mjs');

const req = path.join(dir, '.local/state/herdrchat/asks/req');
fs.mkdirSync(req, { recursive: true });
const ask = (id, sessionId) => fs.writeFileSync(path.join(req, `${id}.json`), JSON.stringify({ agent: 'codex', terminal: '', at: 1, request: { session_id: sessionId } }));

// a process that runs a hook (its copy's path, as `herdrchat hooks install` puts it)
const hook = path.join(dir, '.local/share/herdrchat/hooks/ask.sh');
fs.mkdirSync(path.dirname(hook), { recursive: true });
fs.writeFileSync(hook, 'sleep 30\n');
const running = spawn('sh', [hook], { stdio: 'ignore' });
procs.push(running);
// a process that does not: a pid a killed hook had, taken by another program since
const other = spawn('sleep', ['30'], { stdio: 'ignore' });
procs.push(other);
const gone = spawn('true');
await new Promise((resolve) => gone.on('exit', resolve));
await new Promise((resolve) => setTimeout(resolve, 200));

ask(`1-${running.pid}`, 'live');
ask(`2-${other.pid}`, 'taken');
ask(`3-${gone.pid}`, 'gone');

test('a request is open only while its pid runs the hook, not when that pid is taken by another process', async () => {
  assert.equal(await askOpen('s', 'm', `1-${running.pid}`), true);
  assert.equal(await askOpen('s', 'm', `2-${other.pid}`), false);
  assert.equal(await askOpen('s', 'm', `3-${gone.pid}`), false);
  assert.deepEqual((await strayAsks('s', 'm', 'codex')).map((a) => a.request.session_id), ['live']);
});
