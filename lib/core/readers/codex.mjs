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
//          at the end, which marks `end` (a question it asks the async way, with its
//          choices in the text, is a final answer too, but the turn goes on after it)
//     tool CommandExecution (a command it ran), FileChange (files it added, changed or
//          removed), and any other item but reasoning, as one line
import path from 'node:path';
import { getTerminal, machineOf } from '../hc.mjs';
import { homeShell, logAfter } from '../home.mjs';
import { itemsAfter } from '../cursor.mjs';

export const app = 'codex';
export const processes = ['codex'];

const textOf = (content) => (Array.isArray(content) ? content.filter((c) => /^text$/i.test(c.type) && c.text).map((c) => c.text).join('\n') : '');
const short = (s, max = 120) => {
  const one = String(s || '').replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 3)}...` : one;
};

function commandOf(item) {
  const argv = Array.isArray(item.command) ? item.command : [item.command];
  // a shell's `-lc <command>` shows as the command itself
  const at = argv.findIndex((a) => a === '-lc' || a === '-c');
  return at >= 0 && argv[at + 1] ? argv[at + 1] : argv.join(' ');
}

function entryItems(entry) {
  if (entry.type !== 'event_msg' || entry.payload?.type !== 'item_completed') return [];
  const item = entry.payload.item || {};
  switch (item.type) {
    case 'UserMessage': {
      const t = textOf(item.content).trim();
      return t ? [{ role: 'you', text: t }] : [];
    }
    case 'AgentMessage': {
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

export function conversationAfter(lines, cursor) {
  return itemsAfter(lines, cursor, entryItems);
}

// "[[dd-]hh:]mm:ss", as ps prints how long a process has run
export function seconds(etime) {
  const t = String(etime).trim();
  const [days, rest] = t.includes('-') ? t.split('-') : ['0', t];
  const parts = rest.split(':').map(Number);
  while (parts.length < 3) parts.unshift(0);
  return Number(days) * 86400 + parts[0] * 3600 + parts[1] * 60 + parts[2];
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
