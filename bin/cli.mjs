#!/usr/bin/env node
// herdrchat's command line: set up, start, stop and look at one profile.
//
//   herdrchat <command> [--profile <name>]
//     init       make the profile's config.env from the example when it is missing
//     install    run it as a service of the system (launchd, systemd): it starts at
//                login and comes back after a crash; start, stop, status go through it
//     uninstall  no service any more (it is stopped)
//     start      start (or restart) it: the service, or else its own hc terminal
//     stop       stop it
//     status     how it runs, its folders, sessions, its chat app, errors today
//     logs       today's log (-n <lines>, --errors for ERROR and WARN only)
//     run        run in the foreground (what start keeps running)
//
// The profile is --profile or HERDRCHAT_PROFILE (default "default"); where its files are
// is in lib/core/config.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = `herdrchat <command> [--profile <name>]

  init       make the profile's config.env from the example when it is missing
  install    run it as a service of the system: starts at login, back after a crash
  uninstall  no service any more (it is stopped)
  start      start (or restart) it: the service, or else its own hc terminal
  stop       stop it
  status     how it runs, its folders, sessions, its chat app, errors today
  logs       today's log (-n <lines>, --errors for ERROR and WARN only)
  run        run in the foreground (what start keeps running)`;

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
const { serviceOf } = await import('../lib/core/service.mjs');
const places = placesOf();

const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const firstSession = () => loadConfig().sessions[0];
const CONNECT_WAIT_MS = 60000; // a first attempt that times out (15 s) is tried again

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

// What the bot needs wherever it runs (hc starts a program with the core's environment,
// and a service with almost none): hc's full path, our PATH, the profile and the folders.
// Nothing else, so no agent's variables come along.
function botEnv() {
  const hcPath = findHc();
  if (!hcPath) throw new Error('hc is not on PATH: install herdr-core first (https://herdr.app)');
  const env = { HERDRCHAT_HC: hcPath, HERDRCHAT_PROFILE: places.profile };
  for (const k of ['PATH', 'HERDRCHAT_HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME']) if (process.env[k]) env[k] = process.env[k];
  return env;
}

const service = () => serviceOf({ profile: places.profile, root: ROOT, node: process.execPath, env: botEnv(), stateDir: STATE_DIR });

function failedToConnect(where, result) {
  console.error(`${where} but did not reach its chat app within ${CONNECT_WAIT_MS / 1000} s.`);
  if (result.errors.length) console.error(`Its errors:\n  ${result.errors.join('\n  ')}`);
  console.error('It keeps retrying; `herdrchat logs --errors` shows more.');
  process.exitCode = 1;
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

  // The service file is written again each time (a moved node or hc is picked up), and
  // the bot in an hc terminal is stopped first: two bots would answer every message.
  async install() {
    const svc = service();
    if (!svc) throw new Error(`no launchd or systemd on ${process.platform}: run \`herdrchat start\` instead`);
    loadConfig(); // a config that cannot start the bot fails here, not in the service
    await stopEverywhere();
    svc.unload();
    svc.write(svc.content);
    const since = new Date().toISOString();
    svc.load();
    const result = await waitConnected(since);
    if (!result.ok) return failedToConnect(`The ${svc.kind} service ${svc.name} is installed`, result);
    console.log(`Installed the ${svc.kind} service ${svc.name} (${svc.file}); it is running, connected to its chat app, starts at login and comes back after a crash.`);
    if (svc.kind === 'systemd') console.log('To keep it running after you log out: loginctl enable-linger');
  },

  async uninstall() {
    const svc = service();
    if (!svc?.installed()) {
      console.log('No herdrchat service is installed for this profile.');
      return;
    }
    svc.unload();
    svc.remove();
    console.log(`Removed the ${svc.kind} service ${svc.name}; the bot is stopped. \`herdrchat start\` runs it in an hc terminal again.`);
  },

  async start() {
    await stopEverywhere();
    const svc = service();
    const since = new Date().toISOString();
    if (svc?.installed()) {
      if (svc.loaded()) svc.restart();
      else svc.load();
      const result = await waitConnected(since);
      if (!result.ok) return failedToConnect(`The ${svc.kind} service ${svc.name} started`, result);
      console.log(`Started the ${svc.kind} service ${svc.name} (profile ${places.profile}); connected to its chat app.`);
      return;
    }
    const session = firstSession();
    const env = Object.entries(botEnv()).map(([k, v]) => `${k}=${shellQuote(v)}`).join(' ');
    const run = `env ${env} ${shellQuote(process.execPath)} ${shellQuote(path.join(ROOT, 'bin', 'herdrchat.mjs'))}`;
    const loop = `while true; do ${run}; echo 'herdrchat exited, restarting in 3 s'; sleep 3; done`;
    await hc(session, ['run', '--bg', '--no-parent', '--name', places.terminal, '--cwd', ROOT, '--', 'sh', '-c', loop]);
    const result = await waitConnected(since);
    if (!result.ok) return failedToConnect(`${places.terminal} started in hc session ${session}`, result);
    console.log(`Started ${places.terminal} (profile ${places.profile}) in hc session ${session}; connected to its chat app. \`herdrchat install\` makes it a service that starts at login and comes back after a crash.`);
  },

  async stop() {
    await stopEverywhere();
    const svc = service();
    if (svc?.installed()) svc.unload(); // stays installed: \`herdrchat start\` loads it again; at login it starts again
    console.log(`Stopped herdrchat (profile ${places.profile}). Until it starts again, nothing reaches its chat app.`);
  },

  async status() {
    console.log(`profile   ${places.profile}`);
    console.log(`settings  ${CONFIG_FILE}${fs.existsSync(CONFIG_FILE) ? '' : '  (missing: run `herdrchat init`)'}`);
    console.log(`state     ${STATE_DIR}`);
    if (!fs.existsSync(CONFIG_FILE)) return;
    const cfg = loadConfig();
    console.log(`sessions  ${cfg.sessions.join(', ')}`);
    // how it runs: the service, an hc terminal, or not at all
    const svc = service();
    const inTerminal = (await terminalState(cfg.sessions[0])) === 'live';
    if (svc?.installed()) {
      const st = svc.state();
      console.log(`running   ${st.running ? `yes, as the ${svc.kind} service ${svc.name}${st.pid ? ` (pid ${st.pid})` : ''}` : `no: the ${svc.kind} service ${svc.name} is stopped (\`herdrchat start\`)`}`);
      const gone = svc.nodeGone();
      if (gone) console.log(`          the service runs ${gone}, which is gone (node moved): \`herdrchat install\` again`);
      if (inTerminal) console.log(`          also in hc terminal ${places.terminal}: two bots; \`herdrchat start\` keeps one`);
    } else {
      console.log(`running   ${inTerminal ? `yes, in hc terminal ${places.terminal} (session ${cfg.sessions[0]}); \`herdrchat install\` makes it a service` : 'no (`herdrchat start`, or `herdrchat install` for a service)'}`);
    }
    // what its chat app needs, without printing a secret
    console.log(`chat      ${cfg.chat}`);
    if (cfg.chat === 'feishu') {
      let token = null;
      try {
        token = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'user-token.json'), 'utf8'));
      } catch {
        // no /auth yet
      }
      console.log(`owner     ${cfg.ownerOpenId ? 'set' : 'not set: message the bot, it says what to put in config.env'}`);
      console.log(`/auth     ${!token ? 'not done (muting, labels and pins need it)' : (token.refreshUntil || 0) > Date.now() ? 'done' : 'expired: send /auth again'}`);
    } else if (cfg.chat === 'telegram') {
      console.log(`token     ${cfg.env.TELEGRAM_BOT_TOKEN ? 'set' : 'missing: TELEGRAM_BOT_TOKEN from @BotFather'}`);
      console.log(`owner     ${cfg.env.TELEGRAM_OWNER_ID ? 'set' : 'not set: message the bot, it says what to put in config.env'}`);
    }
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
