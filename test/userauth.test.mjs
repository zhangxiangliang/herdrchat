import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createUserAuth } from '../lib/chats/feishu/userauth.mjs';

test('without /auth the bot does nothing as you: no token, no calls', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdrchat-auth-test-'));
  try {
    const ua = createUserAuth({ appId: 'cli_test', appSecret: 'secret' }, dir);
    assert.equal(await ua.allowed(), false);
    assert.equal(await ua.setMuted(['oc_x'], true), null);
    assert.equal(await ua.pin('oc_x'), null);
    assert.equal(await ua.addToFeedGroup('ofg_x', ['oc_x']), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a refresh that does not get through is not a revoked /auth; one Feishu refuses is', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdrchat-auth-test-'));
  const real = globalThis.fetch;
  try {
    // a token that needs a refresh now
    fs.writeFileSync(path.join(dir, 'user-token.json'), JSON.stringify({ access: 'a', accessUntil: 0, refresh: 'r', refreshUntil: Date.now() + 86400000 }));
    const ua = createUserAuth({ appId: 'cli_test', appSecret: 'secret' }, dir);
    globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
    await assert.rejects(ua.allowed(), /fetch failed/, 'offline: not known, so not false');
    globalThis.fetch = async () => ({ json: async () => ({ error: 'invalid_grant' }) });
    assert.equal(await ua.allowed(), false, 'refused: revoked');
  } finally {
    globalThis.fetch = real;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
