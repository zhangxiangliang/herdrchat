import assert from 'node:assert/strict';
import test from 'node:test';
import { createRedactor, redactValue } from '../lib/core/redact.mjs';

const redact = createRedactor({ env: {} });
const out = (text) => redact(text)?.text ?? text;

test('keys with a shape of their own are hidden, and say what they were', () => {
  const cases = [
    ['key sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx here', 'key [hidden: Anthropic key] here'],
    ['OPENAI sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz', 'OPENAI [hidden: OpenAI key]'],
    ['ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789', '[hidden: GitHub token]'],
    ['github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz', '[hidden: GitHub token]'],
    ['glpat-AbCdEfGhIjKlMnOpQrSt', '[hidden: GitLab token]'],
    ['xoxb-1234567890-abcdefghij', '[hidden: Slack token]'],
    ['AKIAIOSFODNN7EXAMPLE', '[hidden: AWS key]'],
    ['AIzaSyA1234567890abcdefghijklmnopqrstuv', '[hidden: Google key]'],
    ['sk_live_AbCdEfGhIjKlMnOpQrStUv', '[hidden: Stripe key]'],
    ['npm_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789', '[hidden: npm token]'],
    ['123456789:AAEhBP0av18kSdF-aXbC_dEfGhIjKlMnOpQ', '[hidden: Telegram token]'],
    ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', '[hidden: JWT]'],
  ];
  for (const [from, to] of cases) assert.equal(out(from), to, from);
});

test('a private key block, a header\'s token and a URL\'s password are hidden, what is around them kept', () => {
  assert.equal(out('a\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEA\nAAAA\n-----END OPENSSH PRIVATE KEY-----\nb'), 'a\n[hidden: private key]\nb');
  assert.equal(out('Authorization: Bearer abcdefghijklmnop.qrstuvwxyz'), 'Authorization: Bearer [hidden: token]');
  assert.equal(out('postgres://app:s3cr3tP4ss@db.local:5432/x'), 'postgres://app:[hidden: password]@db.local:5432/x');
});

test('a value given to a name that says secret is hidden, the name kept; a count is not a secret', () => {
  assert.equal(out('API_KEY=abc123def456'), 'API_KEY=[hidden: secret]');
  assert.equal(out('"client_secret": "abcDEF123456"'), '"client_secret": "[hidden: secret]"');
  assert.equal(out('password: hunter22'), 'password: [hidden: secret]');
  assert.equal(out('export GITHUB_TOKEN="x1y2z3w4v5"'), 'export GITHUB_TOKEN="[hidden: secret]"');
  for (const plain of ['max_tokens: 4096', 'tokens=150000', 'context 30% (300k tokens)', 'password: short', 'the token is in the vault', 'pwd=', 'TOKEN_COUNT: 12345678']) {
    assert.equal(out(plain), plain, plain);
  }
});

test('what only looks random is left alone: commit ids, UUIDs, paths, ids of the chat apps', () => {
  for (const plain of [
    'commit 9b8fc97 and 33d572b4f1e2a3b4c5d6e7f8091a2b3c4d5e6f70',
    'session c482bf41-ec1a-491d-84e2-4ae83f0e009a',
    '/home/me/.local/state/herdr-core/default/files/t2/om_x100b0123456789abcdef0123456789ab-0.png',
    'oc_0123456789abcdef0123456789abcdef ou_owner om_x100b0123456789abcdef0123456789ab',
    'sk-short',
  ]) assert.equal(out(plain), plain, plain);
});

test('the bot\'s own secrets and your words are hidden wherever they are; off hides nothing', () => {
  const r = createRedactor({ env: { FEISHU_APP_SECRET: 'Zq9wErTy7uIoPa', TELEGRAM_BOT_TOKEN: 'plain-token-value-1', HERDR_SESSIONS: 'herdrchat,takewalks' }, redactWords: ['Acme Corp'] });
  assert.equal(r('secret is Zq9wErTy7uIoPa, plain-token-value-1 too').text, 'secret is [hidden: secret], [hidden: secret] too');
  assert.equal(r('a deal with acme corp').text, 'a deal with [hidden: word]');
  assert.equal(r('herdrchat and takewalks'), null, 'only secrets and your words');
  assert.equal(createRedactor({ redact: false, env: { FEISHU_APP_SECRET: 'Zq9wErTy7uIoPa' } })('Zq9wErTy7uIoPa'), null);
});

test('every string of a value is hidden where it should be, a file\'s text too; what has nothing to hide comes back as it was', () => {
  const look = { title: 'Worked', body: [{ kind: 'text', markdown: 'API_KEY=abc123def456' }, { kind: 'image', ref: 'img_v3_x' }], footer: { app: 'claude' } };
  const { value, hits } = redactValue(redact, look);
  assert.deepEqual(value, { title: 'Worked', body: [{ kind: 'text', markdown: 'API_KEY=[hidden: secret]' }, { kind: 'image', ref: 'img_v3_x' }], footer: { app: 'claude' } });
  assert.deepEqual(hits, ['secret']);
  assert.equal(look.body[0].markdown, 'API_KEY=abc123def456', 'what it was given is not changed');
  const file = redactValue(redact, { name: 'a.md', data: Buffer.from('token: abcdef123456') });
  assert.equal(file.value.data.toString(), 'token: [hidden: secret]');
  const same = { a: ['x', 1, null] };
  assert.deepEqual(redactValue(redact, same), { value: same, hits: [] });
});

test('every member of the chat contract either carries words out (and is hidden) or carries none: a new one cannot slip past', async () => {
  const { CHAT_MEMBERS } = await import('../lib/chats/contract.mjs');
  const { CARRIES, CARRIES_NOTHING } = await import('../lib/core/redact.mjs');
  const functions = Object.entries(CHAT_MEMBERS).filter(([, d]) => /^\(/.test(d)).map(([m]) => m);
  const sorted = functions.filter((m) => !CARRIES.includes(m) && !CARRIES_NOTHING.includes(m));
  assert.deepEqual(sorted, [], 'say in redact.mjs whether these carry words out');
  assert.deepEqual(CARRIES.filter((m) => CARRIES_NOTHING.includes(m)), []);
  assert.deepEqual([...CARRIES, ...CARRIES_NOTHING].filter((m) => !functions.includes(m)), [], 'no member that is not in the contract');
});
