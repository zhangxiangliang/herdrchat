import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { hooksStatus, installHooks, placesOfHooks, uninstallHooks } from '../lib/core/hooks.mjs';
import { askOf, clip } from '../lib/core/asks.mjs';
import * as claude from '../lib/core/readers/claude.mjs';
import * as codex from '../lib/core/readers/codex.mjs';

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'hooks', 'ask.sh');
const out = (text) => JSON.parse(text).hookSpecificOutput.decision;

// A made-up home, with only what a test puts in it.
function home() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdrchat-hooks-test-'));
  return { dir, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// ---------- Claude: what it asks, and the decision for your answer ----------

const ask = (request, id = '100-42') => ({ id, agent: 'claude', terminal: 't1', request });

test('a Claude permission is a card with its own words: Yes, Yes and don\'t ask again when it offers rules, No', () => {
  const req = { tool_name: 'Bash', cwd: '/w', tool_input: { command: 'rm -rf node_modules', description: 'Remove node_modules' }, permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'rm -rf node_modules' }], behavior: 'allow', destination: 'localSettings' }] };
  const d = claude.askDialog(ask(req));
  assert.equal(d.kind, 'permission');
  assert.equal(d.text, 'Remove node_modules\n$ rm -rf node_modules');
  assert.deepEqual(d.options.map((o) => o.label), ['Yes', "Yes, and don't ask again", 'No']);
  assert.deepEqual(out(claude.decide(ask(req), d, { pick: 1 }).decision), { behavior: 'allow' });
  assert.deepEqual(out(claude.decide(ask(req), d, { pick: 2 }).decision), { behavior: 'allow', updatedPermissions: req.permission_suggestions });
  assert.equal(out(claude.decide(ask(req), d, { pick: 3 }).decision).behavior, 'deny');
  assert.deepEqual(out(claude.decide(ask(req), d, { esc: true }).decision).interrupt, true, 'Esc stops Claude, as in its own prompt');
  const plain = claude.askDialog(ask({ tool_name: 'Edit', cwd: '/w', tool_input: { file_path: '/w/a.txt', old_string: 'x', new_string: 'y' } }));
  assert.deepEqual(plain.options.map((o) => o.label), ['Yes', 'No'], 'no rules offered, no "don\'t ask again"');
  assert.equal(plain.text, 'Edit a.txt\n- x\n+ y');
});

test('Claude\'s questions: one card each, and the answers go back together, as its own prompt sends them', () => {
  const req = { tool_name: 'AskUserQuestion', tool_input: { questions: [
    { question: 'Which framework?', header: 'Framework', options: [{ label: 'React', description: 'the usual' }, { label: 'Vue' }], multiSelect: false },
    { question: 'Which sizes?', header: 'Sizes', options: [{ label: 'S' }, { label: 'M' }, { label: 'L' }], multiSelect: true },
  ] } };
  const a = ask(req);
  const first = claude.askDialog(a);
  assert.equal(first.key, '100-42#0');
  assert.deepEqual(first.options.map((o) => o.label), ['React', 'Vue', 'Type your own answer']);
  assert.equal(first.free.n, 3);
  assert.equal(first.text, 'Framework\nWhich framework?\nReact: the usual\n(question 1 of 2)');
  const kept = claude.decide(a, first, { pick: 1 });
  assert.deepEqual(kept, { partial: { 'Which framework?': 'React' } }, 'nothing sent before every question has its answer');
  const second = claude.askDialog(a, kept.partial);
  assert.equal(second.key, '100-42#1');
  assert.equal(second.multi, true);
  const sent = out(claude.decide(a, second, { pick: 'tab', ticks: { 1: true, 3: true } }, kept.partial).decision);
  assert.equal(sent.behavior, 'allow');
  assert.deepEqual(sent.updatedInput.answers, { 'Which framework?': 'React', 'Which sizes?': 'S, L' });
  assert.deepEqual(sent.updatedInput.questions, req.tool_input.questions, 'its questions go back with the answers');
  const own = out(claude.decide(a, second, { pick: 4, text: 'XL only' }, kept.partial).decision);
  assert.equal(own.updatedInput.answers['Which sizes?'], 'XL only', 'your own words, in a multi-select too');
  assert.equal(claude.decide(a, first, { pick: 3, text: '  ' }), null, 'no words, no answer');
});

test('Claude\'s plan: start, start and accept its edits, or keep planning', () => {
  const a = ask({ tool_name: 'ExitPlanMode', tool_input: { plan: '1. Do it\n2. Test it' } });
  const d = claude.askDialog(a);
  assert.equal(d.kind, 'plan');
  assert.equal(d.text, '1. Do it\n2. Test it');
  assert.deepEqual(out(claude.decide(a, d, { pick: 1 }).decision), { behavior: 'allow', updatedInput: { plan: '1. Do it\n2. Test it' } });
  assert.deepEqual(out(claude.decide(a, d, { pick: 2 }).decision).updatedPermissions, [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]);
  assert.equal(out(claude.decide(a, d, { pick: 3 }).decision).behavior, 'deny');
});

test('Codex: Yes, No, or Answer in the terminal (no decision: its own prompt comes up)', () => {
  const a = { id: '7-9', agent: 'codex', request: { tool_name: 'Bash', tool_input: { command: 'curl -sI https://example.com', description: 'Check the site' } } };
  const d = codex.askDialog(a);
  assert.equal(d.text, 'Check the site\n$ curl -sI https://example.com');
  assert.deepEqual(d.options.map((o) => o.label), ['Yes', 'No', 'Answer in the terminal']);
  assert.deepEqual(out(codex.decide(a, d, { pick: 1 }).decision), { behavior: 'allow' });
  assert.equal(out(codex.decide(a, d, { pick: 2 }).decision).behavior, 'deny');
  assert.equal(out(codex.decide(a, d, { esc: true }).decision).interrupt, undefined, 'no interrupt: Codex refuses fields it does not know');
  assert.deepEqual(codex.decide(a, d, { pick: 3 }), { decision: '' });
  assert.equal(codex.requestWords('mcp__fs__read', { path: '/a' }), 'fs: read\n{\n "path": "/a"\n}');
});

test('a long request is cut on the card, and says so', () => {
  assert.equal(clip('a\nb\nc', { lines: 2 }), 'a\nb\n… (the rest is in the terminal)');
  assert.equal(clip('short'), 'short');
  assert.equal(askOf({ labels: { 'herdrchat.ask': '12-34' } }), '12-34');
  assert.equal(askOf({ labels: { 'herdrchat.ask': '../x' } }), '', 'only an id it made');
});

// ---------- installing it ----------

test('installing puts herdrchat\'s hook in beside what is there, once, keeps a copy first, and uninstalling takes only it out', () => {
  const h = home();
  const places = placesOfHooks({}, h.dir);
  fs.mkdirSync(path.join(h.dir, '.claude'));
  const mine = { model: 'x', hooks: { PermissionRequest: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-own.sh' }] }], Stop: [{ hooks: [{ type: 'command', command: 'stop.sh' }] }] } };
  fs.writeFileSync(path.join(h.dir, '.claude', 'settings.json'), JSON.stringify(mine));
  installHooks(['claude', 'codex'], places);
  installHooks(['claude', 'codex'], places);
  const after = JSON.parse(fs.readFileSync(path.join(h.dir, '.claude', 'settings.json'), 'utf8'));
  assert.equal(after.model, 'x');
  assert.equal(after.hooks.PermissionRequest.length, 2, 'yours, and herdrchat\'s once');
  assert.match(after.hooks.PermissionRequest[1].hooks[0].command, /herdrchat\/hooks\/ask\.sh' claude 1790$/);
  assert.equal(after.hooks.PermissionRequest[1].hooks[0].timeout, 1800);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h.dir, '.claude', 'settings.json.herdrchat-backup'), 'utf8')), mine);
  assert.equal(fs.existsSync(path.join(h.dir, '.codex')), false, 'an agent that is not set up here is left alone');
  assert.equal(fs.statSync(places.hook).mode & 0o777, 0o700);
  assert.deepEqual(hooksStatus(places).map((a) => [a.agent, a.there, a.in]), [['claude', true, true], ['codex', false, false]]);
  uninstallHooks(places);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h.dir, '.claude', 'settings.json'), 'utf8')), mine);
  assert.equal(fs.existsSync(places.hook), false);
  h.done();
});

test('Codex gets its hook in hooks.json with a status line, and a file that is not JSON is never touched', () => {
  const h = home();
  const places = placesOfHooks({}, h.dir);
  fs.mkdirSync(path.join(h.dir, '.codex'));
  installHooks(['codex'], places);
  const entry = JSON.parse(fs.readFileSync(path.join(h.dir, '.codex', 'hooks.json'), 'utf8')).hooks.PermissionRequest[0].hooks[0];
  assert.match(entry.command, / codex 590$/);
  assert.equal(entry.timeout, 600);
  assert.match(entry.statusMessage, /herdrchat/);
  fs.mkdirSync(path.join(h.dir, '.claude'));
  fs.writeFileSync(path.join(h.dir, '.claude', 'settings.json'), '{ not json');
  assert.throws(() => installHooks(['claude', 'codex'], places), /not a JSON object/);
  assert.equal(fs.readFileSync(path.join(h.dir, '.claude', 'settings.json'), 'utf8'), '{ not json');
  h.done();
});

// ---------- the hook itself, with a made-up hc ----------

// Runs ask.sh in a made-up home, with an `hc` that answers `get` from a file and logs the
// labels it is given. `steps(dir)` runs while it waits.
function runHook({ agent = 'claude', wait = 5, grace, env = {}, status = 'blocked', steps = async () => {} } = {}) {
  const h = home();
  const bin = path.join(h.dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(h.dir, 'status'), status);
  fs.writeFileSync(path.join(bin, 'hc'), `#!/bin/sh
case "$1" in
  get) s=$(cat "$HOME/status"); l=$(cat "$HOME/label" 2>/dev/null)
       if [ "$s" = gone ]; then echo '{"state":"finished"}'; exit 0; fi
       printf '{"labels":{"herdrchat.ask":"%s"},"state":"live","status":{"app":"x","state":"%s"}}\\n' "$l" "$s" ;;
  label) echo "$3" >> "$HOME/labels"; v="\${3#herdrchat.ask=}"; printf '%s' "$v" > "$HOME/label" ;;
esac
`, { mode: 0o755 });
  return new Promise((resolve) => {
    const child = execFile('sh', [HOOK, agent, String(wait), ...(grace ? [String(grace)] : [])], { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: h.dir, HC_TERMINAL_ID: 't1', ...env } }, (err, stdout) => {
      const asks = path.join(h.dir, '.local/state/herdrchat/asks');
      const left = fs.existsSync(asks) ? [...fs.readdirSync(path.join(asks, 'req')), ...fs.readdirSync(path.join(asks, 'ans'))] : [];
      const labels = fs.existsSync(path.join(h.dir, 'labels')) ? fs.readFileSync(path.join(h.dir, 'labels'), 'utf8').trim().split('\n') : [];
      resolve({ stdout, labels, left, done: h.done });
    });
    child.stdin.end(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' } }));
    steps(h.dir);
  });
}
const until = async (check) => { for (let i = 0; i < 100 && !check(); i += 1) await new Promise((ok) => setTimeout(ok, 50)); };
const reqDir = (dir) => path.join(dir, '.local/state/herdrchat/asks/req');

test('the hook leaves the request, labels its terminal, prints the answer written for it, and cleans up', async () => {
  let request;
  const r = await runHook({
    steps: async (dir) => {
      await until(() => fs.existsSync(reqDir(dir)) && fs.readdirSync(reqDir(dir)).length);
      const file = fs.readdirSync(reqDir(dir))[0];
      request = JSON.parse(fs.readFileSync(path.join(reqDir(dir), file), 'utf8'));
      fs.writeFileSync(path.join(dir, '.local/state/herdrchat/asks/ans', file), '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}');
    },
  });
  assert.equal(request.agent, 'claude');
  assert.equal(request.terminal, 't1');
  assert.deepEqual(request.request, { tool_name: 'Bash', tool_input: { command: 'ls' } });
  assert.equal(out(r.stdout).behavior, 'allow');
  assert.match(r.labels[0], /^herdrchat\.ask=\d+-\d+$/);
  assert.equal(r.labels.at(-1), 'herdrchat.ask=', 'the label goes');
  assert.deepEqual(r.left, [], 'nothing left behind');
  r.done();
});

test('the hook goes with no decision when Claude is answered in the terminal, when the terminal ends, outside hc, and when time runs out', async () => {
  const answered = await runHook({ steps: async (dir) => { await new Promise((ok) => setTimeout(ok, 1500)); fs.writeFileSync(path.join(dir, 'status'), 'working'); } });
  assert.equal(answered.stdout, '', 'blocked, then working: answered there');
  answered.done();
  const ended = await runHook({ steps: async (dir) => { await new Promise((ok) => setTimeout(ok, 500)); fs.writeFileSync(path.join(dir, 'status'), 'gone'); } });
  assert.equal(ended.stdout, '');
  ended.done();
  const outside = await runHook({ env: { HC_TERMINAL_ID: '' } });
  assert.equal(outside.stdout, '');
  assert.deepEqual(outside.labels, [], 'nothing done outside hc');
  outside.done();
  const never = await runHook({ wait: 30, grace: 2, status: 'working' });
  assert.equal(never.stdout, '', 'Claude never showed it waits (answered at once): gone after the grace, not after 30 s');
  never.done();
  const late = await runHook({ agent: 'codex', wait: 2, status: 'working' });
  assert.equal(late.stdout, '', 'Codex works on while it waits; out of time, its own prompt comes');
  assert.deepEqual(late.left, []);
  late.done();
});

test('Codex through its background service runs the hook with no terminal: the request names none, no label is set, and the answer still comes back', async () => {
  let request;
  const r = await runHook({
    agent: 'codex',
    env: { HC_TERMINAL_ID: '' },
    steps: async (dir) => {
      await until(() => fs.existsSync(reqDir(dir)) && fs.readdirSync(reqDir(dir)).length);
      const file = fs.readdirSync(reqDir(dir))[0];
      request = JSON.parse(fs.readFileSync(path.join(reqDir(dir), file), 'utf8'));
      fs.writeFileSync(path.join(dir, '.local/state/herdrchat/asks/ans', file), '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"no"}}}');
    },
  });
  assert.equal(request.terminal, '');
  assert.equal(request.agent, 'codex');
  assert.equal(out(r.stdout).behavior, 'deny');
  assert.deepEqual(r.labels, [], 'no terminal to label: herdrchat labels it');
  assert.deepEqual(r.left, []);
  r.done();
});

test('a request with no terminal is this Codex terminal\'s when it is of its session', () => {
  const file = '.codex/sessions/2026/01/02/rollout-2026-01-02T10-00-00-th-1.jsonl';
  assert.equal(codex.isOf({ request: { session_id: 'th-1' } }, file), true);
  assert.equal(codex.isOf({ request: { transcript_path: `/Users/x/${file}` } }, file), true);
  assert.equal(codex.isOf({ request: { session_id: 'th-2' } }, file), false);
  assert.equal(codex.isOf({ request: { session_id: 'th-1' } }, null), false);
});
