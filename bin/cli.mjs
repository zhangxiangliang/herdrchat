#!/usr/bin/env node
// herdrchat's command line: set up, start, stop and look at one profile.
//
//   herdrchat <command> [--profile <name>]
//     init     make the profile's config.env from the example when it is missing
//     start    start (or restart) it in its own hc terminal, kept running
//     stop     stop it
//     status   running or not, its folders, sessions, /auth, errors today
//     logs     today's log (-n <lines>, --errors for ERROR and WARN only)
//     run      run in the foreground (what start keeps running)
//
// The profile is --profile or HERDRCHAT_PROFILE (default "default"); where its files are
// is in lib/core/config.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = `herdrchat <command> [--profile <name>]

  init     make the profile's config.env from the example when it is missing
  start    start (or restart) it in its own hc terminal, kept running
  stop     stop it
  status   running or not, its folders, sessions, /auth, errors today
  logs     today's log (-n <lines>, --errors for ERROR and WARN only)
  run      run in the foreground (what start keeps running)`;

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const value = argv[i + 1];
  argv.splice(i, 2);
  return value;
};
const profile = flag('--profile');
if (profile) process.env.HERDRCHAT_PROFILE = profile;
const lines = Number(flag('-n') || 40);
const errorsOnly = argv.includes('--errors');
const command = argv.find((a) => !a.startsWith('-'));

// after the profile is set: lib/core/config.mjs reads it when it loads
const { CONFIG_FILE, STATE_DIR, loadConfig, makeDirs, placesOf } = await import('../lib/core/config.mjs');
const { hc } = await import('../lib/core/hc.mjs');
const places = placesOf();

const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const firstSession = () => loadConfig().sessions[0];
const CONNECT_WAIT_MS = 30000;

// hc's full path, from HERDRCHAT_HC or PATH
function findHc() {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const file of [process.env.HERDRCHAT_HC, ...dirs.map((d) => path.join(d, 'hc'))].filter(Boolean)) {
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return file;
    } catch {
      // not there
    }
  }
  return null;
}

// The bot runs in the first session listed; after that list changes, an older one may
// still run in another, and two bots answer every message: it is stopped everywhere.
async function stopEverywhere() {
  for (const session of loadConfig().sessions) {
    await hc(session, ['kill', places.terminal]).catch(() => {});
    await hc(session, ['rm', places.terminal]).catch(() => {});
  }
}

// Started is not running: wait until today's log says the bot reached Feishu after
// `since`, and hand back the errors it wrote meanwhile when it does not.
async function waitConnected(since) {
  const log = path.join(STATE_DIR, 'logs', `${new Date().toISOString().slice(0, 10)}.log`);
  const until = Date.now() + CONNECT_WAIT_MS;
  let errors = [];
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 500));
    const lines = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter((l) => l.slice(0, 24) >= since) : [];
    if (lines.some((l) => /\[\w+\] connected\b/.test(l))) return { ok: true }; // the chat app says it is in
    errors = lines.filter((l) => / ERROR /.test(l));
  }
  return { ok: false, errors: [...new Set(errors.map((l) => l.slice(25)))].slice(-5) };
}

async function terminalState(session) {
  try {
    return JSON.parse(await hc(session, ['get', places.terminal, '--json'])).state;
  } catch {
    return null;
  }
}

const commands = {
  init() {
    makeDirs();
    if (fs.existsSync(CONFIG_FILE)) {
      console.log(`${CONFIG_FILE} is there already; edit it.`);
      return;
    }
    fs.copyFileSync(path.join(ROOT, 'config.env.example'), CONFIG_FILE);
    fs.chmodSync(CONFIG_FILE, 0o600);
    console.log(`Made ${CONFIG_FILE}: fill in the app id, the secret and HERDR_SESSIONS.`);
  },

  async start() {
    const session = firstSession();
    const hcPath = findHc();
    if (!hcPath) throw new Error('hc is not on PATH: install herdr-core first (https://herdr.app)');
    // hc starts a program with the core's environment, not ours, and a core started by a
    // service may not have hc on its PATH: hc's full path, our PATH, the profile and the
    // folders go along
    const env = [['HERDRCHAT_HC', hcPath], ...['PATH', 'HERDRCHAT_PROFILE', 'HERDRCHAT_HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME'].map((k) => [k, process.env[k]])]
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}=${shellQuote(v)}`)
      .join(' ');
    const run = `env ${env} ${shellQuote(process.execPath)} ${shellQuote(path.join(ROOT, 'bin', 'herdrchat.mjs'))}`;
    const loop = `while true; do ${run}; echo 'herdrchat exited, restarting in 3 s'; sleep 3; done`;
    await stopEverywhere();
    const since = new Date().toISOString();
    await hc(session, ['run', '--bg', '--no-parent', '--name', places.terminal, '--cwd', ROOT, '--', 'sh', '-c', loop]);
    const result = await waitConnected(since);
    if (!result.ok) {
      console.error(`${places.terminal} started in hc session ${session} but did not reach its chat app within ${CONNECT_WAIT_MS / 1000} s.`);
      if (result.errors.length) console.error(`Its errors:\n  ${result.errors.join('\n  ')}`);
      console.error('It keeps retrying; `herdrchat logs --errors` shows more.');
      process.exitCode = 1;
      return;
    }
    console.log(`Started ${places.terminal} (profile ${places.profile}) in hc session ${session}; connected to its chat app.`);
  },

  async stop() {
    await stopEverywhere();
    console.log(`Stopped ${places.terminal}. Until it starts again, nothing reaches Feishu.`);
  },

  async status() {
    console.log(`profile   ${places.profile} (hc terminal ${places.terminal})`);
    console.log(`settings  ${CONFIG_FILE}${fs.existsSync(CONFIG_FILE) ? '' : '  (missing: run `herdrchat init`)'}`);
    console.log(`state     ${STATE_DIR}`);
    if (!fs.existsSync(CONFIG_FILE)) return;
    const cfg = loadConfig();
    console.log(`sessions  ${cfg.sessions.join(', ')}`);
    console.log(`running   ${(await terminalState(cfg.sessions[0])) === 'live' ? 'yes' : 'no (`herdrchat start`)'}`);
    let token = null;
    try {
      token = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'user-token.json'), 'utf8'));
    } catch {
      // no /auth yet
    }
    console.log(`/auth     ${!token ? 'not done' : (token.refreshUntil || 0) > Date.now() ? 'done' : 'expired: send /auth again'}`);
    const log = path.join(STATE_DIR, 'logs', `${new Date().toISOString().slice(0, 10)}.log`);
    if (fs.existsSync(log)) {
      const text = fs.readFileSync(log, 'utf8');
      const count = (level) => (text.match(new RegExp(` ${level} `, 'g')) || []).length;
      console.log(`today     ${count('ERROR')} errors, ${count('WARN')} warnings (herdrchat logs --errors)`);
    }
  },

  logs() {
    const log = path.join(STATE_DIR, 'logs', `${new Date().toISOString().slice(0, 10)}.log`);
    if (!fs.existsSync(log)) {
      console.log(`No log today (${log}).`);
      return;
    }
    let out = fs.readFileSync(log, 'utf8').trimEnd().split('\n');
    if (errorsOnly) out = out.filter((l) => / (ERROR|WARN) /.test(l));
    console.log(out.slice(-lines).join('\n'));
  },

  async run() {
    await import('./herdrchat.mjs');
  },
};

if (!commands[command]) {
  console.log(USAGE);
  process.exit(command ? 2 : 0);
}
try {
  await commands[command]();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
