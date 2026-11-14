import assert from 'node:assert/strict';
import test from 'node:test';
import { conversationAfter, pickSession, sessionFolder, titleOf, windowIn } from '../lib/core/readers/pi.mjs';
import { agentOf, LISTED } from '../lib/core/readers/index.mjs';
import { startCursor } from '../lib/core/cursor.mjs';

// A Pi session log, shaped as Pi 1.5 writes it (made up, not a real session).
const at = (s) => `2026-01-02T00:00:${String(s).padStart(2, '0')}.000Z`;
const msg = (s, id, message) => JSON.stringify({ type: 'message', id, parentId: null, timestamp: at(s), message });
const LOG = [
  JSON.stringify({ type: 'session', version: 3, id: 'sess', timestamp: at(0), cwd: '/w' }),
  JSON.stringify({ type: 'model_change', id: 'm0', parentId: null, timestamp: at(0), provider: 'zai', modelId: 'glm' }),
  msg(1, 's1', { role: 'system', content: '', sections: { preamble: 'You are…' } }),
  msg(2, 'u1', { role: 'user', content: [{ type: 'text', text: 'list the files' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }] }),
  msg(3, 'a1', { role: 'assistant', content: [{ type: 'thinking', thinking: 'private' }, { type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'ls' } }], provider: 'zai', model: 'glm', usage: { input: 100, output: 5, cacheRead: 900, cacheWrite: 0 }, stopReason: 'toolUse' }),
  msg(4, 'r1', { role: 'toolResult', toolCallId: 'c1', toolName: 'bash', content: [{ type: 'text', text: 'a.txt' }, { type: 'image', data: 'BBBB', mimeType: 'image/jpeg' }] }),
  msg(5, 'a2', { role: 'assistant', content: [{ type: 'text', text: 'One file.' }], provider: 'zai', model: 'glm', usage: { input: 10, output: 3, cacheRead: 1000, cacheWrite: 5 }, stopReason: 'stop' }),
  msg(6, 'b1', { role: 'bashExecution', command: 'git status', output: 'clean', exitCode: 0 }),
  msg(7, 'x1', { role: 'custom', customType: 'todo', content: 'Two left', display: true }),
  msg(7, 'x2', { role: 'custom', customType: 'hidden', content: 'not shown', display: false }),
  msg(8, 'a3', { role: 'assistant', content: [], provider: 'zai', model: 'glm', stopReason: 'error', errorMessage: 'rate limited' }),
];

test('the Pi reader keeps what you typed, what it said, its tools and your ! commands, and where a turn ends', () => {
  const { items } = conversationAfter(LOG, startCursor(at(0)));
  assert.deepEqual(items.map((it) => [it.role, it.text || it.media, Boolean(it.end)]), [
    ['you', 'list the files', false],
    ['image', 'image/png', false],
    ['tool', '▸ bash: ls', false],
    ['image', 'image/jpeg', false],
    ['ai', 'One file.', true],
    ['tool', '▸ you ran: git status', false],
    ['tool', '▸ todo: Two left', false],
    ['ai', '_(rate limited)_', true],
  ]);
  const one = items.find((it) => it.text === 'One file.');
  assert.deepEqual([one.model, one.provider, one.context], ['glm', 'zai', { used: 1015 }], 'for the footer: input, cache read and write');
  assert.equal(new Set(items.map((it) => it.id)).size, items.length);
});

test('a Pi session is found in its folder\'s log folder: the newest whose header names the folder', () => {
  assert.equal(sessionFolder('/Users/a/my proj'), '.pi/agent/sessions/--Users-a-my proj--');
  assert.equal(sessionFolder('C:\\w\\x'), '.pi/agent/sessions/--C--w-x--');
  const list = ['new.jsonl\t"cwd":"/w/other"', 'mid.jsonl\t"cwd":"/w"', 'old.jsonl\t"cwd":"/w"'].join('\n');
  assert.equal(pickSession(list, '/w'), 'mid.jsonl');
  assert.equal(pickSession('', '/w'), null);
});

test('a Pi terminal is read by the Pi reader, though hc names no foreground for it (its own process group)', () => {
  assert.ok(LISTED.some((r) => r.app === 'pi'));
  assert.equal(agentOf({ status: { app: 'pi', state: 'working' } })?.app, 'pi');
  assert.equal(agentOf({ status: { app: 'pi', state: 'done' }, foreground: { name: 'vim', argv: ['vim'] } }), null, 'another program in front: not Pi');
  assert.equal(titleOf('π - herdrchat'), 'herdrchat');
});

test('Pi\'s context window comes from its own model list', () => {
  const store = { zai: { models: [{ id: 'glm', contextWindow: 1000000 }] }, other: { models: [{ id: 'glm', contextWindow: 128000 }] } };
  assert.equal(windowIn(store, 'glm', 'zai'), 1000000);
  assert.equal(windowIn(store, 'glm', 'gone'), 1000000, 'its provider not listed: the same model elsewhere');
  assert.equal(windowIn(store, 'glm'), 1000000, 'no provider named: the first that has it');
  assert.equal(windowIn(null, 'glm'), undefined);
});

test('Pi on Zhipu\'s plan: the host from the model\'s base URL, the key from Pi\'s own auth.json, nothing for anything else', async () => {
  const { baseUrlIn, keyIn } = await import('../lib/core/readers/pi.mjs');
  const { zhipuHost } = await import('../lib/core/zhipu.mjs');
  const store = { 'zai-coding-cn': { models: [{ id: 'glm', contextWindow: 1000000, baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4' }] }, mine: { models: [{ id: 'x', baseUrl: 'https://example.com/v1' }] } };
  assert.equal(zhipuHost({ provider: 'zai-coding-cn', baseUrl: baseUrlIn(store, 'glm', 'zai-coding-cn') }), 'open.bigmodel.cn');
  assert.equal(zhipuHost({ provider: 'mine', baseUrl: baseUrlIn(store, 'x', 'mine') }), null, 'another host: nothing is asked');
  assert.equal(zhipuHost({ provider: 'zai-coding-cn' }), 'open.bigmodel.cn', 'no model list: by its name');
  assert.equal(zhipuHost({ provider: 'zai' }), 'api.z.ai');
  assert.equal(keyIn({ 'zai-coding-cn': { type: 'api_key', key: 'k' } }, 'zai-coding-cn'), 'k');
  assert.equal(keyIn({ anthropic: { type: 'oauth', access: 'a' } }, 'anthropic'), null, 'a sign-in, not a key: none');
  assert.equal(keyIn(null, 'zai-coding-cn'), null);
});
