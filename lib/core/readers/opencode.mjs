// Reader for OpenCode (hc status app "opencode"), through OpenCode's own API: its CLI
// `opencode api <operation>` asks OpenCode's background service, which signs in by itself.
// Nothing here reads its database or its screen, so an OpenCode update that keeps its
// API keeps this working.
//   Which session: the terminal's folder's sessions (session.list), the active one first
//     (session.active), else the one updated last.
//   What becomes an item (from the session's messages, session.message.list):
//     you  a "user" message: what you typed
//     ai   an "assistant" message's text parts; the one an "idle" message follows marks
//          `end` (the turn is over); reasoning is left out
//     tool an assistant's tool parts (shell, write, edit, question, ...), as one line
//   Its dialogs (`dialog`, `answer`): what it waits on is a form (session.form.list: its
//     questions, each with options and maybe your own words) or a permission request
//     (session.permission.list: once, always, reject). One question is shown at a time;
//     the form is sent when each of its questions has an answer. Esc cancels the form, or
//     rejects the request.
import { getTerminal, machineOf } from '../hc.mjs';
import { homeShell } from '../home.mjs';
import { itemsAfter } from '../cursor.mjs';

export const app = 'opencode';
export const processes = ['opencode'];

const short = (s, max = 120) => {
  const one = String(s || '').replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 3)}...` : one;
};
const quote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

// One call to OpenCode's API through its CLI, run in `cwd` (the API answers for that
// folder's project). Its `data` (`whole`: the whole answer), or null when the call failed;
// a call that succeeds with nothing to say (a reply) gives {}.
const EXIT = '__herdrchat_exit=';
async function api(session, machine, cwd, operation, { params = {}, body, whole = false } = {}) {
  const args = [operation, ...Object.entries(params).map(([k, v]) => `--param ${quote(`${k}=${v}`)}`), ...(body ? [`-d ${quote(JSON.stringify(body))}`] : [])].join(' ');
  const out = await homeShell(session, machine, `cd ${quote(cwd)} && opencode api ${args} 2>/dev/null; echo "${EXIT}$?"`);
  const at = out.lastIndexOf(EXIT);
  if (at < 0 || out.slice(at + EXIT.length).trim() !== '0') return null;
  const text = out.slice(0, at).trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return !whole && parsed && 'data' in parsed ? parsed.data : parsed;
  } catch {
    return {};
  }
}

function toolLine(part) {
  const input = part.state?.input || part.input || {};
  if (part.name === 'question') {
    const q = (input.questions || [])[0];
    return `▸ question: ${short(q?.question || q?.title || '')}`;
  }
  const what = input.command || input.filePath || input.path || input.pattern || input.url || input.description || '';
  return `▸ ${part.name || 'tool'}${what ? `: ${short(what)}` : ''}`;
}

// One message, as items. `ends`: an "idle" message comes after it.
function messageItems(m, ends) {
  if (m.type === 'user') {
    const t = String(m.text || '').trim();
    return t ? [{ role: 'you', text: t }] : [];
  }
  if (m.type !== 'assistant') return [];
  const out = [];
  for (const p of m.content || []) {
    if (p.type === 'text' && p.text?.trim()) out.push({ role: 'ai', text: p.text.trim() });
    else if (p.type === 'tool') out.push({ role: 'tool', text: toolLine(p) });
  }
  if (ends) {
    const last = out.map((it) => it.role).lastIndexOf('ai');
    if (last >= 0) out[last].end = true;
  }
  return out;
}

// A session's messages, as log lines the cursor reads ({timestamp, uuid, message, ends}).
export function linesOf(messages) {
  const msgs = Array.isArray(messages) ? messages : [];
  return msgs.map((m, i) => JSON.stringify({
    timestamp: new Date(m.time?.created || 0).toISOString(),
    uuid: m.id,
    message: m,
    ends: msgs.slice(i + 1).find((n) => n.type !== 'assistant' || (n.content || []).some((p) => p.type === 'text'))?.type === 'idle',
  }));
}

const entryItems = (entry) => messageItems(entry.message || {}, entry.ends);

export function conversationAfter(lines, cursor) {
  return itemsAfter(lines, cursor, entryItems);
}

// The session a terminal's OpenCode shows: of its folder's sessions, an active one, else
// the one updated last.
export function pickSession(list, active, cwd) {
  const mine = (Array.isArray(list) ? list : []).filter((s) => s.id && (!s.directory || s.directory === cwd));
  const busy = mine.filter((s) => active && active[s.id]);
  const pool = busy.length ? busy : mine;
  return [...pool].sort((a, b) => (b.updated || 0) - (a.updated || 0))[0]?.id || null;
}

async function where(session, address) {
  const fg = (await getTerminal(session, address)).foreground;
  if (!fg?.cwd) return null;
  const machine = machineOf(address);
  const [list, active] = await Promise.all([api(session, machine, fg.cwd, 'session.list'), api(session, machine, fg.cwd, 'session.active')]);
  const id = pickSession(list, active, fg.cwd);
  return id ? { machine, cwd: fg.cwd, id } : null;
}

// A session's messages, oldest first, back to `since` (an ISO time; all when it is
// earlier than the session): newest first a page at a time, as the API gives them.
const PAGE = 100;
const PAGES = 50;
async function messagesOf(session, w, id, since = '') {
  const all = [];
  let cursor = null;
  for (let i = 0; i < PAGES; i += 1) {
    const params = { sessionID: id, limit: PAGE, ...(cursor ? { cursor } : { order: 'desc' }) };
    const page = await api(session, w.machine, w.cwd, 'session.message.list', { params, whole: true });
    if (!page || !Array.isArray(page.data)) return all.length ? all.reverse() : null;
    all.push(...page.data);
    const oldest = page.data.at(-1)?.time?.created;
    cursor = page.cursor?.next;
    if (page.data.length < PAGE || !cursor || (oldest && new Date(oldest).toISOString() <= since)) break;
  }
  return all.reverse();
}

// What is new since `cursor`: {items, file} (`file` is the session's id), or null when
// the terminal runs no OpenCode whose session is found.
export async function after(session, address, cursor) {
  const w = await where(session, address);
  if (!w) return null;
  const items = [];
  if (cursor.file && cursor.file !== w.id) {
    const old = await messagesOf(session, w, cursor.file, cursor.at);
    if (old) items.push(...conversationAfter(linesOf(old), cursor).items);
  }
  const now = await messagesOf(session, w, w.id, cursor.at);
  if (!now) return null;
  items.push(...conversationAfter(linesOf(now), cursor).items);
  return { items, file: w.id };
}

export async function rest(session, address, cursor) {
  if (!cursor.file) return [];
  const fg = (await getTerminal(session, address).catch(() => null))?.foreground;
  const old = await messagesOf(session, { machine: machineOf(address), cwd: fg?.cwd || '.' }, cursor.file, cursor.at);
  return old ? conversationAfter(linesOf(old), cursor).items : [];
}

// The room's name from the terminal's title, "OC | <session title>".
export function titleOf(title) {
  return String(title || '').replace(/^OC\s*\|\s*/, '').trim();
}

// ---------- its dialogs, through its API ----------

// Answers given to a form's questions so far, until each has one: form id -> {key: value}
const partial = new Map();

const PERMISSION_OPTIONS = [
  { n: 1, label: 'Allow once', value: 'once' },
  { n: 2, label: 'Allow always', value: 'always' },
  { n: 3, label: 'Reject', value: 'reject' },
];

// What it waits on now, as the core shows a dialog: {key, kind, title, text, options:
// [{n, label, value, checked}], multi, free: {n, label} | null, ref}, or null.
export function dialogOf(forms, permissions, answered = new Map()) {
  const form = (Array.isArray(forms) ? forms : [])[0];
  if (form) {
    const done = answered.get(form.id) || {};
    const field = (form.fields || []).find((f) => !(f.key in done));
    if (field) {
      const multi = /multi|array/i.test(field.type || '') || field.multiple === true; // "multiselect" in 2.3
      const options = (field.options || []).map((o, i) => ({ n: i + 1, label: o.label || String(o.value), value: o.value, checked: multi ? false : null }));
      const free = field.custom ? { n: options.length + 1, label: 'Type your own answer', checked: null } : null;
      const left = (form.fields || []).filter((f) => !(f.key in done)).length;
      const text = [field.title, field.description, left > 1 ? `(question ${form.fields.length - left + 1} of ${form.fields.length})` : ''].filter(Boolean).join('\n');
      return { key: `${form.id}#${field.key}`, kind: form.metadata?.kind || 'question', title: form.title, text, options: free ? [...options, free] : options, multi, free, ref: { type: 'form', id: form.id, field: field.key, fields: (form.fields || []).map((f) => f.key) } };
    }
  }
  const request = (Array.isArray(permissions) ? permissions : [])[0];
  if (request) {
    const what = [request.message, request.action, ...(request.resources || [])].filter(Boolean).join('\n');
    return { key: `permission#${request.id}`, kind: 'permission', title: 'Permission', text: what, options: PERMISSION_OPTIONS.map((o) => ({ ...o, checked: null })), multi: false, free: null, ref: { type: 'permission', id: request.id } };
  }
  return null;
}

export async function dialog(session, address) {
  const w = await where(session, address);
  if (!w) return null;
  const [forms, permissions] = await Promise.all([
    api(session, w.machine, w.cwd, 'session.form.list', { params: { sessionID: w.id } }),
    api(session, w.machine, w.cwd, 'session.permission.list', { params: { sessionID: w.id } }),
  ]);
  return dialogOf(forms, permissions, partial);
}

// Answers what `shown` (from dialog()) asks: {pick, text, ticks, esc}. True when sent.
export async function answer(session, address, shown, { pick, text, ticks, esc } = {}) {
  const w = await where(session, address);
  if (!w || !shown?.ref) return false;
  const params = { sessionID: w.id };
  if (shown.ref.type === 'permission') {
    const decision = esc ? 'reject' : shown.options.find((o) => o.n === pick)?.value;
    if (!decision) return false;
    return api(session, w.machine, w.cwd, 'session.permission.reply', { params: { ...params, requestID: shown.ref.id }, body: { decision } }).then((r) => r !== null);
  }
  if (esc) {
    partial.delete(shown.ref.id);
    return api(session, w.machine, w.cwd, 'session.form.cancel', { params: { ...params, formID: shown.ref.id } }).then((r) => r !== null);
  }
  let value;
  if (shown.multi) value = shown.options.filter((o) => o.value !== undefined && ticks?.[o.n]).map((o) => o.value);
  else if (shown.free && (pick === shown.free.n || (pick === undefined && text))) value = String(text || '').trim();
  else value = shown.options.find((o) => o.n === pick)?.value;
  if (value === undefined || value === '') return false;
  const done = { ...(partial.get(shown.ref.id) || {}), [shown.ref.field]: value };
  if (shown.ref.fields.some((f) => !(f in done))) {
    partial.set(shown.ref.id, done);
    return true; // the next question is shown; the form goes once all are answered
  }
  partial.delete(shown.ref.id);
  return api(session, w.machine, w.cwd, 'session.form.reply', { params: { ...params, formID: shown.ref.id }, body: { answer: done } }).then((r) => r !== null);
}
