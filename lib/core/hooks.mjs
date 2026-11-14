// `herdrchat hooks`: puts herdrchat's PermissionRequest hook (lib/hooks/ask.sh) in Claude
// Code's and Codex's own settings, takes it out again, and tells whether it is in. With
// it, what they ask you comes to the chat in their own words (./asks.mjs); without it the
// screen is read. Only herdrchat's own entries are ever added or taken out; the first
// change to a file keeps a copy of it beside it (<file>.herdrchat-backup).
//   the hook       ~/.local/share/herdrchat/hooks/ask.sh (a copy of lib/hooks/ask.sh)
//   Claude Code    $CLAUDE_CONFIG_DIR/settings.json (~/.claude): hooks.PermissionRequest
//   Codex          $CODEX_HOME/hooks.json (~/.codex): hooks.PermissionRequest; Codex asks
//                  you once to trust a new hook (/hooks in Codex)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOOK_FILE } from './asks.mjs';

const SOURCE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'ask.sh');
const MARK = 'herdrchat/hooks/ask.sh';

// How long each waits for your answer before it hands the question back to the terminal
// (seconds; the agent's own timeout for the hook is a little longer, so the hook always
// ends first and says nothing, rather than being stopped).
const WAIT = { claude: 1790, codex: 590 };
const TIMEOUT = { claude: 1800, codex: 600 };

export function placesOfHooks(env = process.env, home = os.homedir()) {
  const claudeDir = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  const codexDir = env.CODEX_HOME || path.join(home, '.codex');
  return {
    hook: path.join(home, HOOK_FILE),
    agents: [
      { agent: 'claude', name: 'Claude Code', dir: claudeDir, file: path.join(claudeDir, 'settings.json') },
      { agent: 'codex', name: 'Codex', dir: codexDir, file: path.join(codexDir, 'hooks.json') },
    ],
  };
}

const shq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
function entryOf(agent, hook) {
  const one = { type: 'command', command: `sh ${shq(hook)} ${agent} ${WAIT[agent]}`, timeout: TIMEOUT[agent] };
  if (agent === 'codex') one.statusMessage = 'Waiting for your answer in herdrchat (your chat)';
  return { hooks: [one] };
}
const ours = (entry) => (entry?.hooks || []).some((h) => String(h?.command || '').includes(MARK));

function readJson(file) {
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, 'utf8');
  if (!text.trim()) return {};
  try {
    const value = JSON.parse(text);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch {
    // said below
  }
  throw new Error(`${file} is not a JSON object; fix it first, nothing was changed`);
}

function writeJson(file, value) {
  if (fs.existsSync(file) && !fs.existsSync(`${file}.herdrchat-backup`)) fs.copyFileSync(file, `${file}.herdrchat-backup`);
  const mode = fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : 0o600;
  const tmp = `${file}.herdrchat-tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  fs.renameSync(tmp, file);
}

// Each agent: {agent, name, file, there (its folder exists), in (the hook is in its file)}
export function hooksStatus(places = placesOfHooks()) {
  return places.agents.map((a) => {
    const there = fs.existsSync(a.dir);
    let inFile = false;
    try {
      inFile = there && (readJson(a.file).hooks?.PermissionRequest || []).some(ours);
    } catch {
      inFile = false;
    }
    return { ...a, there, in: inFile && fs.existsSync(places.hook) };
  });
}

// Puts the hook in for `agents` (names; the ones whose folder exists). What changed, as
// lines; throws before changing a file it cannot read.
export function installHooks(agents, places = placesOfHooks()) {
  const done = [];
  const picked = places.agents.filter((a) => agents.includes(a.agent) && fs.existsSync(a.dir));
  const files = picked.map((a) => ({ a, value: readJson(a.file) })); // every file read before any is written
  fs.mkdirSync(path.dirname(places.hook), { recursive: true, mode: 0o700 });
  fs.copyFileSync(SOURCE, places.hook);
  fs.chmodSync(places.hook, 0o700);
  done.push(`the hook: ${places.hook}`);
  for (const { a, value } of files) {
    const hooks = value.hooks && typeof value.hooks === 'object' ? value.hooks : {};
    const list = (Array.isArray(hooks.PermissionRequest) ? hooks.PermissionRequest : []).filter((e) => !ours(e));
    value.hooks = { ...hooks, PermissionRequest: [...list, entryOf(a.agent, places.hook)] };
    writeJson(a.file, value);
    done.push(`${a.name}: ${a.file}`);
  }
  return done;
}

// Takes herdrchat's entries out of every agent's file, and the hook away. What changed.
export function uninstallHooks(places = placesOfHooks()) {
  const done = [];
  for (const a of places.agents) {
    if (!fs.existsSync(a.file)) continue;
    const value = readJson(a.file);
    const list = value.hooks?.PermissionRequest;
    if (!Array.isArray(list) || !list.some(ours)) continue;
    const left = list.filter((e) => !ours(e));
    if (left.length) value.hooks.PermissionRequest = left;
    else delete value.hooks.PermissionRequest;
    if (!Object.keys(value.hooks).length) delete value.hooks;
    writeJson(a.file, value);
    done.push(`${a.name}: ${a.file}`);
  }
  if (fs.existsSync(places.hook)) {
    fs.rmSync(places.hook);
    done.push(`the hook: ${places.hook}`);
  }
  return done;
}
