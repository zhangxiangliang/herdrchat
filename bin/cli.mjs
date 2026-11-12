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
// is in lib/config.mjs.
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

// after the profile is set: lib/config.mjs reads it when it loads
const { CONFIG_FILE, STATE_DIR, loadConfig, makeDirs, placesOf } = await import('../lib/config.mjs');
const { hc } = await import('../lib/hc.mjs');
const places = placesOf();

const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const firstSession = () => loadConfig().sessions[0];

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
    // hc starts a program with its own environment: the profile and folders go along
    const env = ['HERDRCHAT_PROFILE', 'HERDRCHAT_HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME']
      .filter((k) => process.env[k])
      .map((k) => `${k}=${shellQuote(process.env[k])}`)
      .join(' ');
    const run = `env ${env} ${shellQuote(process.execPath)} ${shellQuote(path.join(ROOT, 'bin', 'herdrchat.mjs'))}`;
    const loop = `while true; do ${run}; echo 'herdrchat exited, restarting in 3 s'; sleep 3; done`;
    await hc(session, ['kill', places.terminal]).catch(() => {});
    await hc(session, ['rm', places.terminal]).catch(() => {});
    await hc(session, ['run', '--bg', '--no-parent', '--name', places.terminal, '--cwd', ROOT, '--', 'sh', '-c', loop]);
    console.log(`Started ${places.terminal} (profile ${places.profile}) in hc session ${session}.`);
  },

  async stop() {
    const session = firstSession();
    await hc(session, ['kill', places.terminal]).catch(() => {});
    await hc(session, ['rm', places.terminal]).catch(() => {});
    console.log(`Stopped ${places.terminal}.`);
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
