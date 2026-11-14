// Reader for Claude Code (hc status app "claude-code"): its own transcript.
//   Where: the terminal's foreground pid names the session in ~/.claude/sessions/<pid>.json
//     ({sessionId, cwd}); the transcript is
//     ~/.claude/projects/<cwd with every non-alphanumeric as "-">/<sessionId>.jsonl.
//   What becomes an item:
//     you  a prompt you typed (user entry from a human), a message you sent mid-turn
//          (attachment "queued_command" from a human; the queue also carries Claude
//          Code's own task notifications, which are left out), or your answers to its
//          questions (the AskUserQuestion result's `answers`)
//     ai   the assistant's text; `end` marks the turn's last answer (stop_reason
//          "end_turn"). Some of what it says while it works is stored only as a
//          "narration" block: a thinking block whose signature names narration, holding a
//          condensed version of that text. Those count as text; plain thinking does not.
//     tool a tool it called, as one line
//     image an image you pasted (`from: 'you'`) or one a tool showed it (`from: 'ai'`:
//          a screenshot, an image file it read), as {media, data} (base64)
//   For the footer: each answer's model and how full its context was (its request's
//     input, cache read and cache write tokens, as Claude Code counts it for its status
//     line). Its context window and the account's limits come from Claude Code itself
//     (`meter`, below), never from a model call.
import { getTerminal, machineOf } from '../hc.mjs';
import { homeFile, homeShell, logAfter } from '../home.mjs';
import { knownSoon } from '../meter.mjs';
import { itemsAfter } from '../cursor.mjs';
import { answerAsk, clip, decision, openAsk, partialOf } from '../asks.mjs';

function text(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content) || content.some((b) => b.type === 'tool_result')) return '';
  return content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

function isNarration(block) {
  if (block.type !== 'thinking' || !block.thinking?.trim() || !block.signature) return false;
  try {
    return Buffer.from(block.signature, 'base64').includes('narration');
  } catch {
    return false;
  }
}

function toolLine(block) {
  const input = block.input || {};
  const what = input.description || input.command || input.file_path || input.pattern || input.url || input.prompt || '';
  const short = String(what).replace(/\s+/g, ' ').trim();
  return `▸ ${block.name || 'tool'}${short ? `: ${short.length > 120 ? `${short.slice(0, 117)}...` : short}` : ''}`;
}

// The images in a user entry's content: ones you pasted (top-level blocks) and ones a
// tool gave the assistant to look at (inside tool results: screenshots, image files).
function images(content, human) {
  if (!Array.isArray(content)) return [];
  const out = [];
  const add = (b, from) => {
    if (b?.type === 'image' && b.source?.type === 'base64' && b.source.data) out.push({ role: 'image', from, media: b.source.media_type, data: b.source.data });
  };
  for (const b of content) {
    if (human) add(b, 'you');
    if (b.type === 'tool_result' && Array.isArray(b.content)) b.content.forEach((x) => add(x, 'ai'));
  }
  return out;
}

// The items one entry holds, in block order (an entry may hold text and tool calls).
function entryItems(entry) {
  if (entry.isSidechain) return [];
  if (entry.type === 'user' && !entry.isMeta && entry.origin?.kind === 'human') {
    const t = text(entry.message?.content).trim();
    return [...(t ? [{ role: 'you', text: t }] : []), ...images(entry.message?.content, true)];
  }
  const shown = entry.type === 'user' && !entry.isMeta ? images(entry.message?.content, false) : [];
  if (shown.length) return shown;
  const answers = entry.type === 'user' && entry.toolUseResult?.answers;
  if (answers && typeof answers === 'object') {
    const t = Object.entries(answers).map(([q, a]) => `${q} → ${a}`).join('\n').trim();
    return t ? [{ role: 'you', text: t }] : [];
  }
  const queued = entry.type === 'attachment' && entry.attachment?.type === 'queued_command' && entry.attachment;
  if (queued) {
    const t = queued.origin?.kind === 'human' ? text(queued.prompt).trim() : '';
    return t ? [{ role: 'you', text: t }] : [];
  }
  if (entry.type !== 'assistant' || !Array.isArray(entry.message?.content)) return [];
  const end = entry.message.stop_reason === 'end_turn';
  // the model that wrote it; "<synthetic>" marks a reply Claude Code made up itself
  const model = /^[^<]/.test(entry.message.model || '') ? entry.message.model : undefined;
  const u = entry.message.usage;
  const used = u ? (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) : 0;
  const context = model && used ? { used } : undefined;
  const out = [];
  for (const b of entry.message.content) {
    const said = b.type === 'text' ? b.text : isNarration(b) ? b.thinking : '';
    if (said && said.trim()) out.push({ role: 'ai', text: said.trim(), end, model, context });
    else if (b.type === 'tool_use') out.push({ role: 'tool', text: toolLine(b), model, context });
  }
  // only thinking: nothing to show, but how full the context is now
  if (!out.length && context) out.push({ role: 'meta', model, context });
  return out;
}

export function conversationAfter(lines, cursor) {
  return itemsAfter(lines, cursor, entryItems);
}

export const app = 'claude-code';
export const short = 'claude'; // its name in a post's footer
export const processes = ['claude'];

// What is new since `cursor`: {items, file}, or null when the terminal runs no readable
// Claude. When the session moved to a new transcript (/clear, resume), what is left in
// the cursor's old file comes first.
export async function after(session, address, cursor) {
  const machine = machineOf(address);
  const pid = (await getTerminal(session, address)).foreground?.pid;
  if (!pid) return null;
  const meta = JSON.parse(await homeFile(session, machine, `.claude/sessions/${pid}.json`));
  if (!meta.sessionId || !meta.cwd) return null;
  const file = `.claude/projects/${meta.cwd.replace(/[^A-Za-z0-9]/g, '-')}/${meta.sessionId}.jsonl`;
  const items = [];
  if (cursor.file && cursor.file !== file) {
    try {
      items.push(...(await logAfter(session, machine, cursor.file, cursor, entryItems)));
    } catch {
      // the old transcript is gone; nothing left to read there
    }
  }
  items.push(...(await logAfter(session, machine, file, cursor, entryItems)));
  return { items, file };
}

// What the cursor's file still holds once the program is gone.
export function rest(session, address, cursor) {
  return logAfter(session, machineOf(address), cursor.file, cursor, entryItems);
}

// ---------- its context window and the account's limits, from Claude Code itself ----------
// `claude -p /context` and `claude -p /usage` are answered by Claude Code on its own: no
// model is asked, nothing is spent (total_cost_usd 0, no API time). Run on the machine the
// terminal is on, without leaving a session behind.

// "**Tokens:** 13.8k / 1m (1%)" -> 1000000
export function contextWindowIn(text) {
  const m = /Tokens:\**\s*[\d.]+[km]?\s*\/\s*([\d.]+)\s*([km]?)/i.exec(String(text));
  if (!m) return undefined;
  return Math.round(Number(m[1]) * ({ k: 1e3, m: 1e6 }[m[2].toLowerCase()] || 1)) || undefined;
}

// "Current session: 2% used · …" and "Current week (all models): 57% used · …" -> the
// 5-hour and 7-day limits; none when /usage says neither (an API key has no limits)
export function limitsIn(text) {
  const limits = [];
  for (const [re, name] of [[/^Current session:\s*([\d.]+)% used/m, '5-hour'], [/^Current week \(all models\):\s*([\d.]+)% used/m, '7-day']]) {
    const m = re.exec(String(text));
    if (m) limits.push({ name, used: Number(m[1]) });
  }
  return limits.length ? limits : undefined;
}

const LIMITS_MS = 5 * 60 * 1000;
const WINDOW_MS = 24 * 60 * 60 * 1000;
const quoteArg = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
const FIRST_WAIT_MS = 10 * 1000;
export async function meter(session, address, { model } = {}) {
  const machine = machineOf(address);
  const run = (cmd) => homeShell(session, machine, `claude -p ${cmd} --no-session-persistence 2>/dev/null`);
  const [contextSize, limits] = await Promise.all([
    model ? knownSoon(`claude|${machine || ''}|window|${model}`, WINDOW_MS, async () => contextWindowIn(await run(`/context --model ${quoteArg(model)}`)), FIRST_WAIT_MS) : undefined,
    knownSoon(`claude|${machine || ''}|limits`, LIMITS_MS, async () => limitsIn(await run('/usage')), FIRST_WAIT_MS),
  ]);
  return { contextSize, limits };
}

// ---------- its dialogs, through herdrchat's hook (../asks.mjs) ----------
// What Claude asks you while the hook runs: a permission for a tool (Yes, Yes and don't
// ask again when Claude offers rules for it, No), its questions (AskUserQuestion: one
// card per question, multi-select boxes, your own words; the answers go back together),
// or its plan (ExitPlanMode). Esc stops Claude, as Esc in its own prompt does. Without
// the hook (or for a dialog it does not see) the screen is read, as before.

const homeRel = (file, cwd) => {
  const f = String(file || '');
  if (cwd && f.startsWith(`${cwd}/`)) return f.slice(cwd.length + 1);
  return f.replace(/^\/(Users|home)\/[^/]+\//, '~/');
};
const diff = (from, to) => [...String(from ?? '').split('\n').map((l) => `- ${l}`), ...String(to ?? '').split('\n').map((l) => `+ ${l}`)].join('\n');

// What a tool would do, in words for its card.
export function toolWords(tool, input = {}, cwd = '') {
  const v = input && typeof input === 'object' ? input : {};
  switch (tool) {
    case 'Bash': return [v.description, `$ ${v.command || ''}`].filter(Boolean).join('\n');
    case 'Write': return `Write ${homeRel(v.file_path, cwd)}\n${v.content || ''}`;
    case 'Edit': return `Edit ${homeRel(v.file_path, cwd)}\n${diff(v.old_string, v.new_string)}`;
    case 'MultiEdit': return `Edit ${homeRel(v.file_path, cwd)}\n${(v.edits || []).map((e) => diff(e?.old_string, e?.new_string)).join('\n')}`;
    case 'NotebookEdit': return `Edit ${homeRel(v.notebook_path, cwd)}\n${v.new_source || ''}`;
    case 'Read': return `Read ${homeRel(v.file_path, cwd)}`;
    case 'Glob': case 'Grep': return `Search for ${v.pattern || ''}${v.path ? ` in ${homeRel(v.path, cwd)}` : ''}`;
    case 'WebFetch': return `Fetch ${v.url || ''}${v.prompt ? `\n${v.prompt}` : ''}`;
    case 'WebSearch': return `Search the web: ${v.query || ''}`;
    default: {
      const mcp = /^mcp__(.+?)__(.+)$/.exec(String(tool || ''));
      const json = Object.keys(v).length ? JSON.stringify(v, null, 1) : '';
      return [mcp ? `${mcp[1]}: ${mcp[2]}` : `Use ${tool || 'a tool'}`, json].filter(Boolean).join('\n');
    }
  }
}

const optionLabel = (o) => (typeof o === 'string' ? o : String(o?.label ?? ''));

// What the request asks now, as a reader's dialog ({key, kind, title, text, options,
// multi, free, ref}), or null. `partial`: the questions of it answered so far.
export function askDialog(ask, partial = {}) {
  const req = ask?.request || {};
  const input = req.tool_input && typeof req.tool_input === 'object' ? req.tool_input : {};
  const ref = { id: ask?.id, tool: req.tool_name };
  if (req.tool_name === 'AskUserQuestion') {
    const questions = (Array.isArray(input.questions) ? input.questions : []).filter((q) => q?.question);
    const i = questions.findIndex((q) => !(q.question in partial));
    if (i < 0) return null;
    const q = questions[i];
    const multi = q.multiSelect === true;
    const options = (Array.isArray(q.options) ? q.options : []).map(optionLabel).filter(Boolean).map((label, j) => ({ n: j + 1, label, value: label, checked: multi ? false : null }));
    const free = { n: options.length + 1, label: 'Type your own answer', checked: null };
    const about = (q.options || []).filter((o) => o?.description).map((o) => `${optionLabel(o)}: ${o.description}`);
    const text = [q.header, q.question, ...about, questions.length > 1 ? `(question ${i + 1} of ${questions.length})` : ''].filter(Boolean).join('\n');
    return { key: `${ask.id}#${i}`, kind: 'question', title: 'Claude asks', text, options: [...options, free], multi, free, ref: { ...ref, question: q.question } };
  }
  if (req.tool_name === 'ExitPlanMode') {
    const options = [{ n: 1, label: 'Yes, start', value: 'allow' }, { n: 2, label: 'Yes, and accept its edits', value: 'accept' }, { n: 3, label: 'No, keep planning', value: 'deny' }];
    return { key: ask.id, kind: 'plan', title: 'Claude has a plan', text: clip(input.plan, { max: 3000, lines: 60 }), options: options.map((o) => ({ ...o, checked: null })), multi: false, free: null, ref };
  }
  const always = Array.isArray(req.permission_suggestions) && req.permission_suggestions.length > 0;
  const options = [{ label: 'Yes', value: 'allow' }, ...(always ? [{ label: "Yes, and don't ask again", value: 'always' }] : []), { label: 'No', value: 'deny' }];
  return { key: ask.id, kind: 'permission', title: 'Claude asks to', text: clip(toolWords(req.tool_name, input, req.cwd)), options: options.map((o, j) => ({ n: j + 1, ...o, checked: null })), multi: false, free: null, ref };
}

const SAID_NO = 'The user said no, in herdrchat (their chat).';
const ESC = 'The user pressed Esc, in herdrchat (their chat).';

// The hook's decision for a reply to `shown` ({pick, text, ticks, esc}): {decision},
// {partial} (more questions to go) or null (no answer to it).
export function decide(ask, shown, reply = {}, partial = {}) {
  const req = ask.request || {};
  if (reply.esc) return { decision: decision({ behavior: 'deny', message: ESC, interrupt: true }) };
  const option = shown.options.find((o) => o.n === reply.pick);
  if (shown.kind === 'question') {
    let said;
    if (option && option.n === shown.free?.n) said = String(reply.text || '').trim();
    else if (shown.multi) said = shown.options.filter((o) => o.n !== shown.free?.n && reply.ticks?.[o.n]).map((o) => o.label).join(', ');
    else said = option?.label;
    if (!said) return null;
    const answers = { ...partial, [shown.ref.question]: said };
    const questions = (req.tool_input?.questions || []).filter((q) => q?.question);
    if (questions.some((q) => !(q.question in answers))) return { partial: answers };
    return { decision: decision({ behavior: 'allow', updatedInput: { ...req.tool_input, answers } }) };
  }
  if (!option) return null;
  if (option.value === 'deny') return { decision: decision({ behavior: 'deny', message: SAID_NO }) };
  if (shown.kind === 'plan') {
    const d = { behavior: 'allow', updatedInput: req.tool_input || {} };
    if (option.value === 'accept') d.updatedPermissions = [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }];
    return { decision: decision(d) };
  }
  if (option.value === 'always') return { decision: decision({ behavior: 'allow', updatedPermissions: req.permission_suggestions }) };
  return { decision: decision({ behavior: 'allow' }) };
}

export async function dialog(session, address) {
  const ask = await openAsk(session, address, 'claude');
  return ask ? askDialog(ask, partialOf(ask.id)) : ask;
}

export function answer(session, address, shown, reply) {
  return answerAsk(session, address, 'claude', shown, reply, decide);
}
