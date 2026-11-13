import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { launchdPlist, serviceOf, systemdUnit } from '../lib/core/service.mjs';

const base = { node: '/opt/node/bin/node', script: '/app/bin/herdrchat.mjs', root: '/app', env: { HERDRCHAT_PROFILE: 'work', PATH: '/a:/b & <c>' }, out: '/state/logs/service.out.log' };

test('the launchd agent runs node and the bot by full paths, comes back after a crash, and escapes what it holds', () => {
  const plist = launchdPlist({ ...base, label: 'app.herdrchat.work' });
  assert.match(plist, /<key>Label<\/key>\s*<string>app\.herdrchat\.work<\/string>/);
  assert.match(plist, /<string>\/opt\/node\/bin\/node<\/string>\s*<string>\/app\/bin\/herdrchat\.mjs<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(plist, /<string>\/a:\/b &amp; &lt;c&gt;<\/string>/);
  assert.doesNotMatch(plist, /CLAUDE/);
});

test('the systemd unit restarts always and quotes its paths and variables', () => {
  const unit = systemdUnit({ ...base, profile: 'work' });
  assert.match(unit, /^ExecStart="\/opt\/node\/bin\/node" "\/app\/bin\/herdrchat\.mjs"$/m);
  assert.match(unit, /^Environment="PATH=\/a:\/b & <c>"$/m);
  assert.match(unit, /^Restart=always$/m);
  assert.match(unit, /^WantedBy=default\.target$/m);
});

test('a service names its file per profile and tells when the node it runs is gone', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'herdrchat-service-test-'));
  const svc = serviceOf({ profile: 'work', root: '/app', node: path.join(home, 'gone', 'node'), env: {}, stateDir: path.join(home, 'state'), platform: 'darwin', home });
  assert.equal(svc.kind, 'launchd');
  assert.equal(svc.file, path.join(home, 'Library', 'LaunchAgents', 'app.herdrchat.work.plist'));
  assert.equal(svc.installed(), false);
  svc.write(svc.content);
  assert.equal(svc.installed(), true);
  assert.equal(svc.nodeGone(), path.join(home, 'gone', 'node'));
  svc.remove();
  assert.equal(svc.installed(), false);
  assert.equal(serviceOf({ profile: 'work', root: '/app', node: 'n', env: {}, stateDir: home, platform: 'linux', home }).file, path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'systemd', 'user', 'herdrchat-work.service'));
  assert.equal(serviceOf({ profile: 'w', root: '/', node: 'n', env: {}, stateDir: home, platform: 'win32', home }), null);
  fs.rmSync(home, { recursive: true, force: true });
});
