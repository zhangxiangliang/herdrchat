// What an agent asks through herdrchat's PermissionRequest hook (lib/hooks/ask.sh, put in
// Claude Code's and Codex's settings by `herdrchat hooks install`, ../core/hooks.mjs): the
// agent's own request, with its own words and options, so no screen is read for it.
//   The hook leaves the request in ~/.local/state/herdrchat/asks/req/<id>.json on the
//   machine the agent runs on, as {agent, terminal, at, request} (`request`: what the
//   agent gave the hook), and labels its terminal herdrchat.ask=<id> while it waits.
//   The answer is written to ans/<id>.json: the hook prints it as its decision; an empty
//   one is no decision (the agent asks in the terminal instead).
// The id is "<seconds>-<pid of the hook>": a request whose hook is gone is not open.
// A hook that cannot tell its terminal (Codex through its shared background service runs
// it outside the terminal) leaves the request with no terminal and labels nothing: the
// core finds its terminal (strayAsks, the reader's strayAsk) and labels it, so it goes
// as any other.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getTerminal, machineOf } from './hc.mjs';
import { homeShell } from './home.mjs';
import { shellQuote } from './shell.mjs';

export const ASKS_DIR = '.local/state/herdrchat/asks';
export const HOOK_FILE = '.local/share/herdrchat/hooks/ask.sh';
export const LABEL = 'herdrchat.ask';
const ID = /^(\d+)-(\d+)$/;

// The terminal's label: the id of the request its hook waits on, or ''.
export const askOf = (record) => {
  const id = record?.labels?.[LABEL] || '';
  return ID.test(id) ? id : '';
};

// Whether the hook is there on a machine (null: here), asked once a minute: without it
// no request comes, and the screen is read at once.
const HOOK_CHECK_MS = 60 * 1000;
const hookSeen = new Map(); // machine -> {at, there}
async function hookThere(session, machine) {
  const seen = hookSeen.get(machine || '');
  if (seen && Date.now() - seen.at < HOOK_CHECK_MS) return seen.there;
  const there = (await homeShell(session, machine, `[ -f ${shellQuote(HOOK_FILE)} ] && echo yes`)).trim() === 'yes';
  hookSeen.set(machine || '', { at: Date.now(), there });
  return there;
}

// Answers given so far, per request: what each question was answered (Claude's
// AskUserQuestion asks several at once; one card shows one, and the decision goes once
// each has its answer). Requests answered in full are not open any more, even before
// their hook has gone.
const partials = new Map(); // id -> {question: answer}
const finished = new Set();
const forget = (set) => { if (set.size > 200) set.delete(set.keys().next().value); };
export const partialOf = (id) => partials.get(id) || {};

// The open request of `agent` the terminal waits on: {id, agent, terminal, at, request};
// null when it waits on none; false when the hook is not on its machine.
export async function openAsk(session, address, agent) {
  const machine = machineOf(address);
  const id = askOf(await getTerminal(session, address));
  if (!id || finished.has(id)) return (await hookThere(session, machine)) ? null : false;
  const pid = id.match(ID)[2];
  const text = await homeShell(session, machine, `kill -0 ${pid} 2>/dev/null && cat ${shellQuote(`${ASKS_DIR}/req/${id}.json`)}`);
  let ask;
  try {
    ask = JSON.parse(text);
  } catch {
    return null;
  }
  return ask?.agent === agent && ask.request ? { ...ask, id } : null;
}

// Whether the hook of request `id` still waits: its request is there and its pid lives.
export async function askOpen(session, machine, id) {
  if (!ID.test(id)) return false;
  const pid = id.match(ID)[2];
  return (await homeShell(session, machine, `[ -f ${shellQuote(`${ASKS_DIR}/req/${id}.json`)} ] && kill -0 ${pid} 2>/dev/null && echo open`)).trim() === 'open';
}

// Whether any request waits on this machine: a look at the folder, no shell, so it can be
// asked every few seconds.
export function asksHere(home = os.homedir()) {
  try {
    return fs.readdirSync(path.join(home, ASKS_DIR, 'req')).some((f) => f.endsWith('.json'));
  } catch {
    return false;
  }
}

// The open requests of `agent` on a machine that name no terminal: [{id, agent, request}].
export async function strayAsks(session, machine, agent) {
  const script = `cd ${shellQuote(`${ASKS_DIR}/req`)} 2>/dev/null && for f in *.json; do [ -f "$f" ] || continue; id="\${f%.json}"; kill -0 "\${id#*-}" 2>/dev/null || continue; printf '%s\t' "$id"; tr -d '\n' < "$f"; echo; done`;
  const out = [];
  for (const line of (await homeShell(session, machine, script)).split('\n')) {
    const tab = line.indexOf('\t');
    const id = line.slice(0, tab);
    if (tab < 0 || !ID.test(id) || finished.has(id)) continue;
    try {
      const ask = JSON.parse(line.slice(tab + 1));
      if (ask?.agent === agent && !ask.terminal && ask.request) out.push({ ...ask, id });
    } catch {
      // half written: the next look gets it
    }
  }
  return out;
}

// Writes the decision for request `id` (its hook prints it); '' is no decision. True
// when written.
async function write(session, machine, id, decision) {
  if (!ID.test(id)) return false;
  const req = `${ASKS_DIR}/req/${id}.json`;
  const ans = `${ASKS_DIR}/ans/${id}.json`;
  const out = await homeShell(session, machine, `[ -f ${shellQuote(req)} ] && printf '%s' ${shellQuote(decision)} > ${shellQuote(`${ans}.tmp`)} && mv ${shellQuote(`${ans}.tmp`)} ${shellQuote(ans)} && echo written`);
  return out.trim() === 'written';
}

// Answers what `shown` (a dialog made from request shown.ref.id) asks. `decide(ask, shown,
// reply, partial)` gives {decision} (the hook's output, '' for none), {partial} (one
// question of several answered: kept, nothing sent yet) or null (not an answer to it).
// True when it went.
export async function answerAsk(session, address, agent, shown, reply, decide) {
  const ask = await openAsk(session, address, agent);
  if (!ask || ask.id !== shown?.ref?.id) return false;
  const out = decide(ask, shown, reply, partialOf(ask.id));
  if (!out) return false;
  if (out.partial) {
    partials.set(ask.id, out.partial);
    forget(partials);
    return true;
  }
  if (!(await write(session, machineOf(address), ask.id, out.decision))) return false;
  partials.delete(ask.id);
  finished.add(ask.id);
  forget(finished);
  return true;
}

// The hook's output for a decision: allow ({updatedInput, updatedPermissions}) or deny
// ({message, interrupt}), as Claude Code's and Codex's PermissionRequest take it.
export const decision = (d) => JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: d } });

// Words for a card, cut to `max` characters and `lines` lines, saying so when cut.
export function clip(text, { max = 1500, lines = 30 } = {}) {
  const all = String(text ?? '').replace(/\r/g, '').split('\n');
  let out = all.slice(0, lines).join('\n');
  let cut = all.length > lines;
  if (out.length > max) {
    out = out.slice(0, max);
    cut = true;
  }
  return cut ? `${out.trimEnd()}\n… (the rest is in the terminal)` : out;
}
