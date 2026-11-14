// Reader for Pi (hc status app "pi"): its own session log (Pi's docs: session-format.md,
// message-types.md).
//   Where: Pi writes each session to ~/.pi/agent/sessions/--<cwd, with "/", "\" and ":" as
//     "-">--/<time>_<id>.jsonl, whose first line (the session header) names its cwd. It
//     names the file only to itself, so herdrchat's Pi extension (lib/hooks/pi-session.js,
//     `herdrchat hooks install pi`) labels the terminal with "<pid> <file>" at each session
//     start; the label is believed when its pid is the terminal's pi. Without it the log
//     is the newest one written since that pi started, in its folder: right for one pi
//     per folder, but two pi in one folder at the same time would both read the newest.
//     Pi runs in a process group of its own, so hc names no foreground for it: its process
//     is the terminal shell's child named pi.
//   What becomes an item: the "message" entries:
//     you   a user message (its text, and images you pasted); a command you ran with "!"
//           (bashExecution) is a tool line
//     ai    the assistant's text; `end` when its stopReason ends the turn (stop, and length,
//           error, aborted); toolUse goes on
//     tool  each tool it calls, as one line
//     image an image a tool showed it (from its result)
//   An extension's message shown in the terminal (custom, display) is a tool line; its
//   tool results, thinking, summaries and system messages are not shown.
//   For the footer: each answer's model and how full its context was (input, cache read
//   and cache write); its window from Pi's own model list (models-store.json); and on
//   Zhipu's GLM Coding Plan (or Z.ai's) the plan's limits (../zhipu.mjs), with the key from
//   Pi's own auth.json, held only for that request.
//   Pi itself asks nothing; an extension's dialog is read off the screen.
import path from 'node:path';
import { getTerminal, machineOf } from '../hc.mjs';
import { homeFile, homeShell, logAfter } from '../home.mjs';
import { itemsAfter } from '../cursor.mjs';
import { knownSoon } from '../meter.mjs';
import { askZhipuLimits, zhipuHost } from '../zhipu.mjs';
import { seconds } from './codex.mjs';

export const app = 'pi';
export const processes = ['pi'];

const short = (s, max = 120) => {
  const one = String(s || '').replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 3)}...` : one;
};
const textOf = (content) => (typeof content === 'string' ? content : Array.isArray(content) ? content.filter((b) => b?.type === 'text' && b.text).map((b) => b.text).join('\n') : '');
const imagesOf = (content, from) => (Array.isArray(content) ? content.filter((b) => b?.type === 'image' && b.data).map((b) => ({ role: 'image', from, media: b.mimeType, data: b.data })) : []);

// a tool call as one line: its name and what it works on
function toolLine(call) {
  const a = call.arguments || {};
  const what = a.command || a.path || a.file_path || a.filePath || a.pattern || a.url || a.query || a.description || '';
  return `▸ ${call.name || 'tool'}${what ? `: ${short(what)}` : ''}`;
}

const ENDS = new Set(['stop', 'length', 'error', 'aborted']);

function entryItems(entry) {
  if (entry.type !== 'message') return [];
  const m = entry.message || {};
  switch (m.role) {
    case 'user': {
      const t = textOf(m.content).trim();
      return [...(t ? [{ role: 'you', text: t }] : []), ...imagesOf(m.content, 'you')];
    }
    case 'assistant': {
      const model = m.model || undefined;
      const provider = m.provider || undefined;
      const u = m.usage;
      const used = u ? (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0) : 0;
      const context = used ? { used } : undefined;
      const out = [];
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (b?.type === 'text' && b.text?.trim()) out.push({ role: 'ai', text: b.text.trim(), model, provider, context });
        else if (b?.type === 'toolCall') out.push({ role: 'tool', text: toolLine(b), model, provider, context });
      }
      if (ENDS.has(m.stopReason)) {
        const last = out.map((it) => it.role).lastIndexOf('ai');
        if (last >= 0) out[last].end = true;
        else if (m.errorMessage) out.push({ role: 'ai', text: `_(${short(m.errorMessage, 300)})_`, end: true, model, provider, context });
      }
      return out;
    }
    case 'toolResult':
      return imagesOf(m.content, 'ai');
    case 'bashExecution':
      return m.command ? [{ role: 'tool', text: `▸ you ran: ${short(m.command)}` }] : [];
    case 'custom': {
      const t = m.display ? textOf(m.content).trim() : '';
      return t ? [{ role: 'tool', text: `▸ ${m.customType || 'extension'}: ${short(t)}` }] : [];
    }
    default:
      return [];
  }
}

export function conversationAfter(lines, cursor) {
  return itemsAfter(lines, cursor, entryItems);
}

// The folder Pi keeps a working directory's sessions in, relative to home.
export function sessionFolder(cwd) {
  return `.pi/agent/sessions/--${String(cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
}

// lines "file\t"cwd":"…"", newest first -> the newest whose session ran in `cwd`
export function pickSession(list, cwd) {
  const hit = String(list || '').split('\n').map((l) => l.split('\t')).find(([f, c]) => f && c === `"cwd":"${cwd}"`);
  return hit ? hit[0] : null;
}

// The pi process the terminal runs: its foreground when hc names it, else the shell's
// child named pi. -> {pid, cwd, age (seconds), labelled (the file its label names, when
// the label is this pi's)} or null
async function piOf(session, address) {
  const term = await getTerminal(session, address);
  const machine = machineOf(address);
  const fg = term.foreground;
  const named = fg?.pid && [fg.name, path.basename(fg.argv?.[0] || '')].includes('pi') ? fg.pid : null;
  const shellPid = Number(term.pid);
  const out = await homeShell(session, machine, named ? `ps -o pid=,etime= -p ${Number(named)}` : `ps -axo pid=,ppid=,etime=,comm= | awk '$2 == ${shellPid} && ($4 == "pi" || $4 ~ /\\/pi$/) { print $1, $3 }'`);
  const [pid, etime] = out.trim().split('\n')[0]?.trim().split(/\s+/) || [];
  if (!pid || !etime) return null;
  return { pid: Number(pid), cwd: fg?.cwd || term.cwd, age: seconds(etime), labelled: labelledFile(term.labels?.[LABEL], Number(pid)) };
}

// herdrchat's Pi extension's label: "<pid> <session file>" -> the file, when it is this
// pi's (a label left by a pi that has quit names another pid)
export const LABEL = 'herdrchat.pi-session';
export function labelledFile(label, pid) {
  const m = /^(\d+) (.+)$/.exec(String(label || '').trim());
  return m && Number(m[1]) === pid ? m[2] : null;
}

async function logOf(session, address) {
  const p = await piOf(session, address);
  if (p?.labelled) return p.labelled;
  if (!p?.cwd) return null;
  const dir = sessionFolder(p.cwd);
  const minutes = Math.ceil(p.age / 60) + 1;
  const list = await homeShell(session, machineOf(address), `cd '${dir.replace(/'/g, "'\\''")}' 2>/dev/null && ls -t -- *.jsonl 2>/dev/null | head -20 | while read -r f; do [ -n "$(find "$f" -mmin -${minutes} 2>/dev/null)" ] && printf '%s\\t%s\\n' "$f" "$(head -n1 "$f" | grep -o '"cwd":"[^"]*"' | head -1)"; done`);
  const file = pickSession(list, p.cwd);
  return file ? `${dir}/${file}` : null;
}

// One log named two ways: from home (found in its folder) or in full (the extension's label).
export const sameLog = (a, b) => a === b || String(a).endsWith(`/${b}`) || String(b).endsWith(`/${a}`);

// What is new since `cursor`: {items, file}, or null when the terminal runs no pi whose
// log is found. What is left in the cursor's old log (another session now) comes first.
export async function after(session, address, cursor) {
  const found = await logOf(session, address);
  if (!found) return null;
  const file = cursor.file && sameLog(cursor.file, found) ? cursor.file : found;
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

// "π - herdrchat" -> "herdrchat": the room's name without Pi's mark
export function titleOf(title) {
  return String(title || '').replace(/^π\s*-\s*/u, '').trim();
}

// For the footer: the model's context window and where it is served from, from Pi's own
// model list (models-store.json: {provider: {models: [{id, contextWindow, baseUrl}]}}).
function modelIn(store, model, provider) {
  const lists = provider && store?.[provider] ? [store[provider], ...Object.values(store)] : Object.values(store || {});
  for (const p of lists) {
    const hit = (p?.models || []).find((m) => m?.id === model);
    if (hit) return hit;
  }
  return null;
}
export const windowIn = (store, model, provider) => modelIn(store, model, provider)?.contextWindow || undefined;
export const baseUrlIn = (store, model, provider) => modelIn(store, model, provider)?.baseUrl || undefined;
// auth.json: {provider: {type: 'api_key', key}} -> the key, or null (OAuth and others: none)
export function keyIn(auth, provider) {
  const a = auth?.[provider];
  return a && ['api_key', 'key'].includes(a.type) && typeof a.key === 'string' ? a.key : null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const LIMITS_MS = 5 * 60 * 1000;
const FIRST_WAIT_MS = 10 * 1000;
export async function meter(session, address, { model, provider } = {}) {
  if (!model) return {};
  const machine = machineOf(address);
  const m = machine || '';
  const store = await knownSoon(`pi|${m}|models`, DAY_MS, async () => JSON.parse(await homeFile(session, machine, '.pi/agent/models-store.json')), FIRST_WAIT_MS);
  const host = provider ? zhipuHost({ provider, baseUrl: baseUrlIn(store, model, provider) }) : null;
  const limits = host ? await knownSoon(`pi|${m}|limits|${provider}`, LIMITS_MS, async () => askZhipuLimits(host, keyIn(JSON.parse(await homeFile(session, machine, '.pi/agent/auth.json')), provider)), FIRST_WAIT_MS) : undefined;
  return { contextSize: windowIn(store, model, provider), limits };
}
