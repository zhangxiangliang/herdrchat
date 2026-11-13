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
