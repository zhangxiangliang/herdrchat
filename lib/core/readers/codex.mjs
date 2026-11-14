// Reader for Codex (hc status app "codex"): its own rollout log.
//   Where: Codex writes each session to ~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl,
//     whose first line (session_meta) names its cwd. It does not keep the file open or
//     name its pid anywhere outside its database, so the log is found as the one written
//     since the terminal's codex started, in the cwd it runs in; with two such, the one
//     whose session began nearest after that start (a resumed session began before it,
//     and then the newest file wins). Found once per codex process.
//   What becomes an item: the "item_completed" events, one per finished item, as Codex
//     itself shows them:
//     you  UserMessage: what you typed
//     ai   AgentMessage: what it said; `phase` "commentary" while it works, "final_answer"
//          at the end, which marks `end` (one it says the async way is a final answer
//          too, but the turn goes on after it). A question it asks the async way is a
//          tool line: its card has it (its questions, below).
//     tool CommandExecution (a command it ran), FileChange (files it added, changed or
//          removed), and any other item but reasoning, as one line
//     meta for the footer, never shown as a post: "turn_context", which starts each turn
//          (the model it runs on), and "token_count", after each request (how full its
//          context is, of how much, and the account's limits, as the reply told Codex)
import path from 'node:path';
import { getTerminal, keys, machineOf, screenTail, send } from '../hc.mjs';
import { homeFile, homeShell, logAfter } from '../home.mjs';
import { seconds } from '../shell.mjs';
import { windowName } from '../meter.mjs';
import { itemsAfter } from '../cursor.mjs';
import { answerAsk, clip, decision, openAsk, strayAsks } from '../asks.mjs';
import { short, textOf } from './text.mjs';

export const app = 'codex';
export const processes = ['codex'];
// some of its questions leave it idle (async ones): the core asks `dialog` at a turn's end
export const asksIdle = true;

// "Unrecognized command '/x'" leaves what you sent in its input box (the last "› " line),
// and what is sent next would be added to it. Ctrl+C empties a box with words in it
// (pressed on an empty one it would start to quit, so only when your words are there).
export function leftInput(screen, sent) {
  const box = String(screen).split('\n').reverse().find((l) => l.startsWith('› '));
  const first = String(sent || '').trim().split('\n')[0];
  return box && first && box.slice(2).includes(first) ? ['ctrl+c'] : null;
}


function commandOf(item) {
  const argv = Array.isArray(item.command) ? item.command : [item.command];
  // a shell's `-lc <command>` shows as the command itself
  const at = argv.findIndex((a) => a === '-lc' || a === '-c');
  return at >= 0 && argv[at + 1] ? argv[at + 1] : argv.join(' ');
}

function entryItems(entry) {
  // each turn starts with the settings it runs with, its model among them
  if (entry.type === 'turn_context') return entry.payload?.model ? [{ role: 'meta', model: entry.payload.model }] : [];
  if (entry.type === 'event_msg' && entry.payload?.type === 'token_count') return meterOf(entry.payload);
  if (entry.type !== 'event_msg' || entry.payload?.type !== 'item_completed') return [];
  const item = entry.payload.item || {};
  switch (item.type) {
    case 'UserMessage': {
      const t = textOf(item.content).trim();
      return t ? [{ role: 'you', text: t }] : [];
    }
    case 'AgentMessage': {
      // an async question: its card (dialog, below) has it, with its options
      const asked = Array.isArray(item.questions) ? item.questions.filter((q) => q?.title) : [];
      if (asked.length) return [{ role: 'tool', text: `▸ asks you: ${short(asked.map((q) => q.title).join(' · '))}` }];
      const t = textOf(item.content).trim();
      return t ? [{ role: 'ai', text: t, end: item.phase === 'final_answer' && item.delivery !== 'async' }] : [];
    }
    case 'CommandExecution':
      return [{ role: 'tool', text: `▸ exec: ${short(commandOf(item))}` }];
    case 'FileChange': {
      const changes = Object.entries(item.changes || {}).map(([file, c]) => `${c.type || 'change'} ${path.basename(file)}`);
      return [{ role: 'tool', text: `▸ edit: ${short(changes.join(', ') || 'files')}` }];
    }
    default:
      return item.type && !/reasoning/i.test(item.type) ? [{ role: 'tool', text: `▸ ${item.type}` }] : [];
  }
}

// A token_count: how full the context is (the last request's tokens, of the model's
// window) and each limit the reply named, by how long its window runs.
function meterOf({ info, rate_limits: r } = {}) {
  const used = info?.last_token_usage?.total_tokens;
  const context = used ? { used, size: info.model_context_window || undefined } : undefined;
  const limits = [r?.primary, r?.secondary].filter((w) => w && Number.isFinite(w.used_percent) && w.window_minutes)
    .sort((a, b) => a.window_minutes - b.window_minutes).map((w) => ({ name: windowName(w.window_minutes), used: w.used_percent }));
  if (!context && !limits.length) return [];
  return [{ role: 'meta', ...(context ? { context } : {}), ...(limits.length ? { limits } : {}) }];
}

export function conversationAfter(lines, cursor) {
  return itemsAfter(lines, cursor, entryItems);
}

// lines "file\t"cwd":"…"\t"timestamp":"…"" -> the log of the codex that started at `started`
export function pickLog(list, cwd, started) {
  const mine = list.split('\n').map((l) => l.split('\t')).filter(([f, c]) => f && c === `"cwd":"${cwd}"`)
    .map(([file, , ts]) => ({ file, began: Date.parse(String(ts || '').replace(/^"timestamp":"|"$/g, '')) || 0 }));
  if (!mine.length) return null;
  const fresh = mine.filter((m) => m.began >= started - 5000).sort((a, b) => a.began - b.began);
  return (fresh[0] || [...mine].sort((a, b) => b.file.localeCompare(a.file))[0]).file;
}

const LIST = (minutes) => [
  `find .codex/sessions -name 'rollout-*.jsonl' -mmin -${minutes} 2>/dev/null | while read -r f; do`,
  `printf '%s\\t%s\\t%s\\n' "$f" "$(head -n1 "$f" | grep -o '"cwd":"[^"]*"' | head -1)" "$(head -n1 "$f" | grep -o '"timestamp":"[^"]*"' | head -1)";`,
  'done',
].join(' ');

const found = new Map(); // `${session}|${address}|${pid}` -> the log (relative to home)

async function logOf(session, address, fg) {
  const key = `${session}|${address}|${fg.pid}`;
  if (found.has(key)) return found.get(key);
  const machine = machineOf(address);
  const age = (await homeShell(session, machine, `ps -o etime= -p ${Number(fg.pid)}`)).trim();
  if (!age) return null;
  const started = Date.now() - seconds(age) * 1000;
  const minutes = Math.ceil((Date.now() - started) / 60000) + 1;
  const file = pickLog(await homeShell(session, machine, LIST(minutes)), fg.cwd, started);
  if (file) found.set(key, file);
  return file;
}

// What is new since `cursor`: {items, file}, or null when the terminal runs no codex whose
// log is found. A new codex in the same terminal (a new process) reads its own log; what
// is left in the cursor's old one comes first.
export async function after(session, address, cursor) {
  const fg = (await getTerminal(session, address)).foreground;
  if (!fg?.pid || !fg.cwd) return null;
  const file = await logOf(session, address, fg);
  if (!file) return null;
  const machine = machineOf(address);
  const items = [];
  if (cursor.file && cursor.file !== file) {
    try {
      items.push(...(await logAfter(session, machine, cursor.file, cursor, entryItems)));
    } catch {
      // the old log is gone; nothing left to read there
    }
  }
  items.push(...(await logAfter(session, machine, file, cursor, entryItems)));
  return { items, file };
}

export function rest(session, address, cursor) {
  return logAfter(session, machineOf(address), cursor.file, cursor, entryItems);
}

// The room's name from the terminal's title: Codex titles it "<thread> | <folder>", led by
// a spinner while it works and by "[ . ] Action Required | " while it waits on you. The
// thread is "codex" until Codex names it; the name stays put while its state changes.
export function titleOf(title) {
  const plain = String(title || '').replace(/^[^\p{L}\p{N}[]+/u, '').replace(/^\[[^\]]*\]\s*Action Required\s*\|\s*/i, '');
  return plain.split(' | ')[0].trim();
}

// ---------- its approvals, through herdrchat's hook (../asks.mjs) ----------
// A command, a patch or an MCP tool Codex asks to run, with Yes, No, and Answer in the
// terminal: Codex shows its own prompt only once the hook is done, so that hands it back
// (an empty decision). Esc says no too (Codex's own prompt takes Esc as "No"). Without
// the hook the screen is read, as before.

// What the request would do, in words for its card.
export function requestWords(tool, input = {}) {
  const v = input && typeof input === 'object' ? input : {};
  const command = Array.isArray(v.command) ? commandOf({ command: v.command }) : v.command;
  if (tool === 'Bash') return [v.description, `$ ${command || ''}`].filter(Boolean).join('\n');
  if (tool === 'apply_patch') return [v.description, String(command || '')].filter(Boolean).join('\n');
  const json = Object.keys(v).length ? JSON.stringify(v, null, 1) : '';
  return [String(tool || 'a tool').replace(/^mcp__(.+?)__/, '$1: '), json].filter(Boolean).join('\n');
}

const OPTIONS = [{ n: 1, label: 'Yes', value: 'allow' }, { n: 2, label: 'No', value: 'deny' }, { n: 3, label: 'Answer in the terminal', value: 'terminal' }];

export function askDialog(ask) {
  const req = ask?.request || {};
  return { key: ask.id, kind: 'permission', title: 'Codex asks to', text: clip(requestWords(req.tool_name, req.tool_input)), options: OPTIONS.map((o) => ({ ...o, checked: null })), multi: false, free: null, ref: { id: ask.id, tool: req.tool_name } };
}

const SAID_NO = 'The user said no, in herdrchat (their chat).';

export function decide(ask, shown, reply = {}) {
  const value = reply.esc ? 'deny' : shown.options.find((o) => o.n === reply.pick)?.value;
  if (value === 'allow') return { decision: decision({ behavior: 'allow' }) };
  if (value === 'deny') return { decision: decision({ behavior: 'deny', message: SAID_NO }) };
  if (value === 'terminal') return { decision: '' };
  return null;
}

// The request a hook left with no terminal (Codex through its shared background service)
// that is this terminal's: its session is the one this terminal's log is of. Its id, or
// null.
export function isOf(ask, file) {
  const req = ask?.request || {};
  if (!file) return false;
  if (req.transcript_path && String(req.transcript_path).endsWith(`/${file}`)) return true;
  return Boolean(req.session_id) && path.basename(file).endsWith(`-${req.session_id}.jsonl`);
}
export async function strayAsk(session, address) {
  const fg = (await getTerminal(session, address)).foreground;
  if (!fg?.pid || !fg.cwd) return null;
  const file = await logOf(session, address, fg);
  if (!file) return null;
  return (await strayAsks(session, machineOf(address), 'codex')).find((a) => isOf(a, file))?.id || null;
}

// ---------- its questions, from its log ----------
// Codex asks you in two ways, both in its log in its own words:
//   request_user_input (Plan mode): a function_call whose arguments are the questions
//     ([{id, header, question, options: [{label, description}]}]); it waits (blocked,
//     kind question) until its function_call_output is written. Codex shows them one at
//     a time ("Question i/n"): a digit picks and goes on to the next, and on the last one
//     sends them all; "None of the above" with notes (moved to, tab, the words, Enter) is
//     your own answer. The card is of the question the screen shows, and is answered
//     with those keys.
//   request_user_input_async: an AgentMessage with `questions` ([{title, options}]);
//     nothing waits (the turn goes on, or ends), and your answer is just your next
//     message. Its card stays while Codex does not work; the tap sends that message
//     (several questions: once each has its answer). Anything you say next answers it.
const QUESTIONS_TAIL = 400; // lines of the log looked at
const QUESTION_SCREEN = 40;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();

// The questions in the log's lines that are not answered: {plan, later}, each null or
// {id, questions}.
export function questionsIn(lines) {
  let plan = null;
  let later = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // the tail's first line, cut
    }
    const p = entry.payload || {};
    if (entry.type === 'response_item' && p.type === 'function_call' && p.name === 'request_user_input') {
      let args = null;
      try {
        args = JSON.parse(p.arguments || '{}');
      } catch {
        args = null;
      }
      const questions = (Array.isArray(args?.questions) ? args.questions : []).filter((q) => q?.question);
      plan = questions.length ? { id: p.call_id || p.id, questions } : null;
    } else if (entry.type === 'response_item' && p.type === 'function_call_output') {
      if (plan && p.call_id === plan.id) plan = null;
    } else if (entry.type === 'event_msg' && (p.type === 'task_complete' || p.type === 'turn_aborted')) {
      plan = null; // its turn is over: nothing waits on it any more
    } else if (entry.type === 'event_msg' && p.type === 'item_completed') {
      const item = p.item || {};
      const questions = Array.isArray(item.questions) ? item.questions.filter((q) => q?.title) : [];
      if (item.type === 'AgentMessage' && questions.length) later = { id: item.id, questions };
      else if (item.type === 'UserMessage') later = null;
    }
  }
  return { plan, later };
}

// The question Codex's screen shows: {index, count, cursor (the option under ›), words
// (all below, on one line)}, or null.
export function questionOnScreen(text) {
  const lines = String(text || '').split('\n');
  let at = -1;
  for (let i = lines.length - 1; i >= 0 && at < 0; i -= 1) if (/^\s*Question \d+\/\d+/.test(lines[i])) at = i;
  if (at < 0) return null;
  const [, i, n] = lines[at].match(/Question (\d+)\/(\d+)/);
  const cursor = lines.slice(at + 1).map((l) => l.match(/^\s*›\s*(\d+)\./)).find(Boolean);
  return { index: Number(i) - 1, count: Number(n), cursor: cursor ? Number(cursor[1]) : 1, words: flat(lines.slice(at + 1).join(' ')) };
}

const optionsOf = (q) => (Array.isArray(q.options) ? q.options : []).map((o) => (typeof o === 'string' ? { label: o } : o)).filter((o) => o?.label);

// The card of Plan mode's question `index`.
export function planDialog(plan, index) {
  const q = plan?.questions?.[index];
  if (!q) return null;
  const opts = optionsOf(q);
  const options = opts.map((o, j) => ({ n: j + 1, label: String(o.label), checked: null }));
  const free = { n: options.length + 1, label: 'None of the above (your own words)', checked: null };
  const about = opts.filter((o) => o.description).map((o) => `${o.label}: ${o.description}`);
  const count = plan.questions.length;
  const text = [q.header, q.question, ...about, count > 1 ? `(question ${index + 1} of ${count})` : ''].filter(Boolean).join('\n');
  return { key: `${plan.id}#${index}`, kind: 'question', title: 'Codex asks', text, options: [...options, free], multi: false, free, ref: { id: plan.id, index, count, question: q.question } };
}

// The card of the first async question not answered yet (`partial`: {index: answer}).
export function laterDialog(later, partial = {}) {
  const index = later?.questions?.findIndex((q, j) => !(j in partial)) ?? -1;
  if (index < 0) return null;
  const q = later.questions[index];
  const options = optionsOf(q).map((o, j) => ({ n: j + 1, label: String(o.label), checked: null }));
  const free = { n: options.length + 1, label: 'Type your own answer', checked: null };
  const count = later.questions.length;
  const text = [q.title, count > 1 ? `(question ${index + 1} of ${count})` : ''].filter(Boolean).join('\n');
  return { key: `${later.id}#${index}`, kind: 'question', title: 'Codex asks', text, options: [...options, free], multi: false, free, idle: true, ref: { id: later.id, index, count, titles: later.questions.map((x) => x.title) } };
}

// The message that answers async questions: the answer alone, or each question's.
export function laterMessage(titles, answers) {
  if (titles.length === 1) return answers[0];
  return titles.map((t, j) => `${t} ${answers[j]}`).join('\n');
}

const laterPartial = new Map(); // async questions' id -> {index: answer}
const laterDone = new Set(); // answered from here, or dismissed (Esc)
const forget = (m) => { if (m.size > 200) m.delete(m.keys().next().value); };

async function questionsOf(session, address) {
  const term = await getTerminal(session, address);
  const fg = term.foreground;
  if (!fg?.pid || !fg.cwd) return null;
  const file = await logOf(session, address, fg);
  if (!file) return null;
  const text = await homeFile(session, machineOf(address), file, { tail: QUESTIONS_TAIL });
  return { term, ...questionsIn(text.split('\n')) };
}

// What Codex asks now: its hook's request, else a question in its log; null when none
// (or when a Plan mode question is not drawn yet), false when it cannot tell (no hook on
// that machine and no question).
export async function dialog(session, address) {
  const ask = await openAsk(session, address, 'codex');
  if (ask) return askDialog(ask);
  const found = await questionsOf(session, address).catch(() => null);
  if (found?.plan) {
    const on = questionOnScreen(await screenTail(session, address, QUESTION_SCREEN).catch(() => ''));
    const d = on && on.count === found.plan.questions.length ? planDialog(found.plan, on.index) : null;
    return d && on.words.includes(flat(d.ref.question).slice(0, 40)) ? d : null;
  }
  const later = found?.later;
  if (later && !laterDone.has(later.id) && !['working', 'blocked'].includes(found.term.status?.state)) {
    const d = laterDialog(later, laterPartial.get(later.id));
    if (d) return d;
  }
  return ask;
}

async function answerPlan(session, address, shown, reply) {
  if (reply.esc) {
    await keys(session, address, ['esc']);
    return true;
  }
  const option = shown.options.find((o) => o.n === reply.pick);
  if (!option) return false;
  if (option.n !== shown.free.n) {
    await keys(session, address, [String(option.n)]);
    return true;
  }
  const text = String(reply.text || '').trim();
  if (!text) return false;
  const on = questionOnScreen(await screenTail(session, address, QUESTION_SCREEN));
  if (!on || on.index !== shown.ref.index) return false;
  const moves = option.n - on.cursor;
  if (moves) await keys(session, address, Array(Math.abs(moves)).fill(moves > 0 ? 'down' : 'up'));
  await sleep(200);
  await keys(session, address, ['tab']);
  await sleep(300);
  await send(session, address, text, { force: true });
  return true;
}

async function answerLater(session, address, shown, reply) {
  const { id, index, titles } = shown.ref;
  if (reply.esc) {
    laterDone.add(id);
    forget(laterDone);
    return true;
  }
  const option = shown.options.find((o) => o.n === reply.pick);
  const said = option && option.n === shown.free.n ? String(reply.text || '').trim() : option?.label;
  if (!said) return false;
  const partial = { ...(laterPartial.get(id) || {}), [index]: said };
  if (Object.keys(partial).length < titles.length) {
    laterPartial.set(id, partial);
    forget(laterPartial);
    return true;
  }
  await send(session, address, laterMessage(titles, titles.map((_, j) => partial[j])));
  laterPartial.delete(id);
  laterDone.add(id);
  forget(laterDone);
  return true;
}

export function answer(session, address, shown, reply = {}) {
  if (shown?.idle) return answerLater(session, address, shown, reply);
  if (shown?.ref?.count) return answerPlan(session, address, shown, reply);
  return answerAsk(session, address, 'codex', shown, reply, decide);
}
