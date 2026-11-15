import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { resetAt, usageIn } from '../lib/core/readers/claude.mjs';
import { accountIn } from '../lib/core/readers/codex.mjs';
import { zhipuAccount, zhipuUsageIn } from '../lib/core/zhipu.mjs';
import { accountsEverywhere } from '../lib/core/usage.mjs';
import * as words from '../lib/core/words.mjs';

const HOUR = 3600 * 1000;
const iso = (ms) => (ms === undefined ? undefined : new Date(ms).toISOString());

test('a reset /usage names is read in its zone, as the next such time within its window', () => {
  const now = Date.parse('2026-11-15T11:30:00Z');
  assert.equal(iso(resetAt('Nov 15 at 11pm (Asia/Singapore)', now, 5 * HOUR)), '2026-11-15T15:00:00.000Z');
  assert.equal(iso(resetAt('Nov 15 at 7:59pm (Asia/Singapore)', now, 168 * HOUR)), '2026-11-15T11:59:00.000Z');
  assert.equal(iso(resetAt('Nov 20, 2:59pm (UTC)', now, 168 * HOUR)), '2026-11-20T14:59:00.000Z', 'the newer "Oct 9, 2:59pm" form');
  assert.equal(iso(resetAt('3pm (Asia/Shanghai)', now, 168 * HOUR)), '2026-11-16T07:00:00.000Z', 'a time alone: the next one');
  assert.equal(resetAt('3pm (Asia/Shanghai)', now, 5 * HOUR), undefined, 'none within the window');
  assert.equal(iso(resetAt('Dec 31 at 11pm (UTC)', Date.parse('2027-01-01T00:30:00Z'), 168 * HOUR)), '2026-12-31T23:00:00.000Z', 'just past, read after New Year: last year');
  assert.equal(iso(resetAt('Jan 2 at 1am (UTC)', Date.parse('2026-12-30T12:00:00Z'), 168 * HOUR)), '2027-01-02T01:00:00.000Z', 'next year');
  assert.equal(iso(resetAt('Mar 8 at 3am (America/New_York)', Date.parse('2026-03-07T12:00:00Z'), 168 * HOUR)), '2026-03-08T07:00:00.000Z', 'just after the clocks go forward');
  assert.equal(typeof resetAt('Nov 15 at 11pm (Mars/Base)', now, 168 * HOUR), 'number', 'a zone not known: this machine\'s');
  assert.equal(resetAt('soon', now, HOUR), undefined);
});

test('/usage\'s windows: the session, the week, and a week of one model', () => {
  const now = Date.parse('2026-11-15T11:30:00Z');
  const text = [
    'You are currently using your subscription to power your Claude Code usage',
    '',
    'Current session: 1% used · resets Nov 15 at 11pm (Asia/Singapore)',
    'Current week (all models): 67% used · resets Nov 15 at 7:59pm (Asia/Singapore)',
    'Current week (Fable): 4% used',
    'Current week (Sonnet only): 2.5% used · resets Nov 15 at 7:59pm (Asia/Singapore)',
    '',
    'What\'s contributing to your limits usage?',
  ].join('\n');
  assert.deepEqual(usageIn(text, now), [
    { name: '5-hour', used: 1, resetsAt: Date.parse('2026-11-15T15:00:00Z') },
    { name: '7-day', used: 67, resetsAt: Date.parse('2026-11-15T11:59:00Z') },
    { name: '7-day Fable', used: 4 },
    { name: '7-day Sonnet', used: 2.5, resetsAt: Date.parse('2026-11-15T11:59:00Z') },
  ]);
  assert.deepEqual(usageIn('Total cost: $0.0000\nUsage: 0 input, 0 output'), [], 'a sign-in with no limits (a setup token)');
});

test('Codex\'s account and limits, from its app server\'s answers', () => {
  const lines = [
    JSON.stringify({ id: 2, result: { account: { type: 'chatgpt', email: 'a@b.c', planType: 'pro' }, requiresOpenaiAuth: true } }),
    JSON.stringify({ id: 3, result: {
      accountId: 'acc-1',
      rateLimits: { limitId: 'codex', primary: { usedPercent: 70, windowDurationMins: 10080, resetsAt: 1794925540 }, secondary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1794750000 }, credits: { hasCredits: false, unlimited: false, balance: '0' } },
      rateLimitsByLimitId: {
        codex: { limitId: 'codex', primary: { usedPercent: 70, windowDurationMins: 10080 } },
        spark: { limitId: 'spark', limitName: 'Spark', primary: { usedPercent: 3, windowDurationMins: 300 } },
      },
    } }),
  ].join('\n');
  assert.deepEqual(accountIn(lines), {
    id: 'codex|acc-1',
    app: 'Codex',
    account: 'a@b.c',
    plan: 'pro',
    limits: [
      { name: '5-hour', used: 12, resetsAt: 1794750000000 },
      { name: '7-day', used: 70, resetsAt: 1794925540000 },
      { name: '5-hour Spark', used: 3 },
    ],
  });
  assert.equal(accountIn(JSON.stringify({ id: 2, result: { account: null, requiresOpenaiAuth: true } })), null, 'no one signed in');
  assert.equal(accountIn(''), null, 'no Codex there');
  const credits = JSON.stringify({ id: 3, result: { rateLimits: { primary: { usedPercent: 1, windowDurationMins: 300 }, credits: { hasCredits: true, unlimited: false, balance: '12.5' } } } });
  assert.equal(accountIn(`${lines.split('\n')[0]}\n${credits}`).credits, '12.5');
  const key = accountIn(JSON.stringify({ id: 2, result: { account: { type: 'apiKey' } } }));
  assert.deepEqual([key.account, key.limits, key.note], [words.API_KEY, [], words.NO_PLAN_LIMITS]);
});

test('a GLM plan\'s key: its limits and reset times, told apart by a hash, never the key', async () => {
  const reply = { success: true, data: { level: 'max', limits: [{ type: 'TIME_LIMIT', unit: 5, number: 1, percentage: 1, nextResetTime: 1 }, { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 17, nextResetTime: 1794757050850 }] } };
  assert.deepEqual(zhipuUsageIn(reply), { plan: 'max', limits: [{ name: '5-hour', used: 17, resetsAt: 1794757050850 }] });
  const asked = [];
  const fetchImpl = async (url, opts) => { asked.push([url, opts.headers.Authorization]); return { ok: true, json: async () => reply }; };
  const a = await zhipuAccount('open.bigmodel.cn', 'secret-key', 'Pi', fetchImpl);
  assert.deepEqual(asked, [['https://open.bigmodel.cn/api/monitor/usage/quota/limit', 'secret-key']]);
  assert.equal(a.app, 'GLM Coding Plan');
  assert.deepEqual([a.plan, a.limits, a.via], ['max', [{ name: '5-hour', used: 17, resetsAt: 1794757050850 }], ['Pi']]);
  assert.doesNotMatch(JSON.stringify(a), /secret-key/);
  assert.equal((await zhipuAccount('open.bigmodel.cn', 'secret-key', 'OpenCode', fetchImpl)).id, a.id, 'the same key is the same account');
  const down = await zhipuAccount('api.z.ai', 'k', 'Pi', async () => { throw new Error('offline'); });
  assert.deepEqual([down.app, down.limits, down.note], ['Z.ai Coding Plan', [], words.NOT_ANSWERED]);
});

test('every machine is asked once, and an account found on several is said once', async () => {
  const here = `${os.hostname()}\n${os.homedir()}`;
  const shells = [];
  const accounts = {
    '': [{ id: 'c1', app: 'Claude Code', account: 'me@x', limits: [] }, { id: 'g', app: 'GLM Coding Plan', limits: [], via: ['OpenCode'] }],
    m2: [{ id: 'g', app: 'GLM Coding Plan', limits: [], via: ['Pi'] }, { id: 'c1', app: 'Claude Code', account: 'me@x', limits: [] }, { id: 'x1', app: 'Codex', limits: [] }],
  };
  const asked = [];
  const found = await accountsEverywhere({
    sessions: ['a', 'b'],
    machines: async (s) => (s === 'a' ? [{ name: 'box', state: 'connected' }, { name: 'm2', state: 'connected' }, { name: 'gone', state: 'connecting' }] : [{ name: 'box', state: 'connected' }, { name: 'far', state: 'connected' }]),
    shell: async (s, m) => { shells.push(`${s}/${m}`); return { box: here, m2: 'm2\n/home/me', far: '' }[m]; },
    usageOn: async (s, m) => { asked.push(m || 'here'); return accounts[m || ''] || []; },
  });
  assert.deepEqual(shells.sort(), ['a/box', 'a/m2', 'b/far'], 'a machine seen from two sessions: once');
  assert.deepEqual(asked.sort(), ['here', 'm2'], 'box is this machine (another core on it): not asked again');
  assert.deepEqual(found.unreached, ['gone', 'far']);
  assert.equal(found.places, 2);
  assert.deepEqual(found.accounts.map((a) => [a.id, a.on, a.via]), [
    ['c1', [os.hostname().split('.')[0], 'm2'], undefined],
    ['g', [os.hostname().split('.')[0], 'm2'], ['OpenCode', 'Pi']],
    ['x1', ['m2'], undefined],
  ]);
});

test('the /usage reply: a block per account, a line per limit with when it resets', () => {
  const now = Date.parse('2026-11-15T11:30:00Z');
  assert.deepEqual([10e3, 12 * 60e3, 3 * HOUR, 3 * HOUR + 5 * 60e3, 48 * HOUR, 52 * HOUR].map(words.inTime), ['1m', '12m', '3h', '3h 5m', '2d', '2d 4h']);
  const report = words.usageReport({
    places: 2,
    unreached: ['far'],
    accounts: [
      { app: 'Claude Code', plan: 'max', account: 'me@x', on: ['m1'], limits: [{ name: '5-hour', used: 1.6, resetsAt: now + 3 * HOUR + 24 * 60e3 }, { name: '7-day Fable', used: 4 }] },
      { app: 'Claude Code', account: 'token@x', on: ['box'], limits: [], note: words.NO_LIMITS_NAMED },
      { app: 'Codex', plan: 'pro', account: 'a@b.c', on: ['m1'], limits: [{ name: '7-day', used: 70, resetsAt: now - 1 }], credits: '12.5' },
      { app: 'GLM Coding Plan', plan: 'max', via: ['OpenCode', 'Pi'], on: ['m1'], limits: [{ name: '5-hour', used: 17, resetsAt: now + 4 * HOUR }] },
    ],
  }, now);
  assert.equal(report, [
    '**Claude Code** (max) · me@x · on m1\n5-hour 2% · resets in 3h 24m\n7-day Fable 4%',
    `**Claude Code** · token@x · on box\n${words.NO_LIMITS_NAMED}`,
    '**Codex** (pro) · a@b.c · on m1\n7-day 70% · resets now\ncredits 12.5',
    '**GLM Coding Plan** (max) · in OpenCode, Pi · on m1\n5-hour 17% · resets in 4h',
    'Not reached: far.',
  ].join('\n\n'));
  assert.doesNotMatch(words.usageReport({ places: 1, accounts: [{ app: 'Codex', on: ['m1'], limits: [] }] }), / on /, 'one machine: not named');
  assert.equal(words.usageReport({ accounts: [], unreached: [] }), words.NO_ACCOUNTS);
});
