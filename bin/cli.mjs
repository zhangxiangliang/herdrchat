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
//     logs       today's log (-n <lines>, --errors for ERROR and WARN only, --day <date>)
//     run        run in the foreground (what start keeps running)
//     version    which herdrchat this is
//
// The profile is --profile or HERDRCHAT_PROFILE (default "default"); where its files are
// is in lib/core/config.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GUIDE = 'https://github.com/zhangxiangliang/herdrchat/blob/main/docs/guide.md';
const USAGE = `herdrchat <command> [--profile <name>]

  init       make the profile's config.env (--chat feishu|telegram picks the app)
  start      start (or restart) it: the service, or else its own hc terminal
  stop       stop it
  status     how it runs, its folders, sessions, its chat app, errors today
  logs       today's log (-n <lines>, --errors for ERROR and WARN only, --day <date>)
  install    run it as a service of the system: starts at login, back after a crash
  uninstall  no service any more (it is stopped)
  run        run in the foreground (what start keeps running)
  version    which herdrchat this is

First time: herdrchat init, fill in the file it names, then herdrchat start.
A second chat app: add --profile <name> to every command.
Environment: HERDRCHAT_PROFILE (same as --profile), HERDRCHAT_HOME (one folder for a
profile's settings and state).
Guide: ${GUIDE}`;

// "herdrchat foo | head" closing the pipe is not an error
process.stdout.on('error', (err) => { if (err.code === 'EPIPE') process.exit(0); throw err; });

function fail(message, code = 2) {
  console.error(message);
  process.exit(code);
}

const argv = process.argv.slice(2);
const flag = (name, what) => {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const value = argv[i + 1];
  if (value === undefined || value.startsWith('-')) fail(`${name} needs ${what}, for example ${name} ${name === '--profile' ? 'telegram' : name === '--chat' ? 'telegram' : name === '--day' ? '2026-01-31' : '100'}`);
  argv.splice(i, 2);
  return value;
};
const profile = flag('--profile', 'a name');
if (profile) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(profile)) fail(`Profile "${profile}": use letters, digits, - and _ only.`);
  process.env.HERDRCHAT_PROFILE = profile;
}
const linesRaw = flag('-n', 'a number of lines');
if (linesRaw !== undefined && !/^\d+$/.test(linesRaw)) fail('-n needs a number of lines, for example -n 100');
const lines = Number(linesRaw || 40);
const day = flag('--day', 'a date');
if (day !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(day)) fail('--day needs a date as YYYY-MM-DD, for example --day 2026-01-31');
const chatFlag = flag('--chat', 'feishu or telegram');
const errorsOnly = argv.includes('--errors');
const helpAsked = argv.some((a) => ['-h', '--help', 'help'].includes(a));
const versionAsked = argv.some((a) => ['-v', '--version', 'version'].includes(a));
const command = argv.find((a) => !a.startsWith('-'));
if (versionAsked) {
  console.log(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version);
  process.exit(0);
}
if (helpAsked || !command) {
  console.log(USAGE);
  process.exit(0);
}
if (process.env.HERDRCHAT_PROFILE && !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(process.env.HERDRCHAT_PROFILE)) fail(`HERDRCHAT_PROFILE "${process.env.HERDRCHAT_PROFILE}": use letters, digits, - and _ only.`);

// after the profile is set: lib/core/config.mjs reads it when it loads
const { CONFIG_FILE, STATE_DIR, chatOf, loadConfig, makeDirs, placesOf } = await import('../lib/core/config.mjs');
const { chatModule, chatNames } = await import('../lib/chats/index.mjs');
const { coreUp, hc, sessionsHere } = await import('../lib/core/hc.mjs');
const { serviceOf } = await import('../lib/core/service.mjs');
const places = placesOf();

const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const again = profile || (places.profile !== 'default' ? places.profile : null) ? ` --profile ${places.profile}` : '';
// the settings, or a plain word on what to do when there are none yet
function config() {
  if (!fs.existsSync(CONFIG_FILE)) fail(`No settings yet at ${CONFIG_FILE}.\nRun \`herdrchat init${again}\`, fill it in, then \`herdrchat start${again}\`.`, 1);
  return loadConfig();
}
const firstSession = () => config().sessions[0];
// the settings the bot needs to start, checked here so a missing key says so at once
// instead of a bot that waits and fails
function readyConfig() {
  config();
  const cfg = loadConfig({ requires: chatModule(chatOf()).requires || [] });
  // a session not on this machine would be made by hc as the bot asks for it: a typo
  const here = sessionsHere();
  const unknown = cfg.sessions.filter((s) => !here.includes(s));
  if (unknown.length) fail(`HERDR_SESSIONS in ${CONFIG_FILE} names ${unknown.join(', ')}, which ${unknown.length > 1 ? 'are' : 'is'} not an hc session on this machine.\nThe sessions here: ${here.join(', ') || 'none (start hc first)'}.`, 1);
  return cfg;
}
// a day's log file: the local date, as the log names its files
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const logFile = (date = today()) => path.join(STATE_DIR, 'logs', `${date}.log`);
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
  for (const session of config().sessions) {
    await hc(session, ['kill', places.terminal]).catch(() => {});
    await hc(session, ['rm', places.terminal]).catch(() => {});
  }
}

// Started is not running: wait until today's log says the bot reached Feishu after
// `since`, and hand back the errors it wrote meanwhile when it does not.
async function waitConnected(since) {
  const log = logFile();
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
  if (!hcPath) throw new Error('hc is not on PATH: install herdr-core first (https://herdr.dev)');
  const env = { HERDRCHAT_HC: hcPath, HERDRCHAT_PROFILE: places.profile };
  for (const k of ['PATH', 'HERDRCHAT_HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME']) if (process.env[k]) env[k] = process.env[k];
  return env;
}

const service = () => serviceOf({ profile: places.id, root: ROOT, node: process.execPath, env: botEnv(), stateDir: STATE_DIR });

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
    const chatName = chatFlag || 'feishu';
    if (!chatNames().includes(chatName)) fail(`--chat ${chatName}: the chat apps are ${chatNames().join(', ')}`);
    makeDirs();
    if (fs.existsSync(CONFIG_FILE)) {
      console.log(`${CONFIG_FILE} is there already; open it and edit it, then run \`herdrchat start${again}\`.`);
      return;
    }
    const example = fs.readFileSync(path.join(ROOT, 'config.env.example'), 'utf8').replace(/^HERDRCHAT_CHAT=.*$/m, `HERDRCHAT_CHAT=${chatName}`);
    fs.writeFileSync(CONFIG_FILE, example, { mode: 0o600 });
    const keys = (chatModule(chatName).requires || []).join(', ');
    console.log(`Made ${CONFIG_FILE} (only you can read it) for ${chatName}.\nOpen it and fill in ${keys} and HERDR_SESSIONS (the hc sessions to mirror), then run \`herdrchat start${again}\`.\nThe guide walks through it: ${GUIDE}`);
  },

  // The service file is written again each time (a moved node or hc is picked up), and
  // the bot in an hc terminal is stopped first: two bots would answer every message.
  async install() {
    const svc = service();
    if (!svc) throw new Error(`no launchd or systemd on ${process.platform}: run \`herdrchat start\` instead`);
    readyConfig(); // a config that cannot start the bot fails here, not in the service
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
    readyConfig();
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
    console.log(`profile   ${places.profile}${places.id !== places.profile ? ` (named ${places.id} for its own folder)` : ''}`);
    console.log(`settings  ${CONFIG_FILE}${fs.existsSync(CONFIG_FILE) ? '' : `  (none yet: run \`herdrchat init${again}\`)`}`);
    console.log(`state     ${STATE_DIR}`);
    if (!fs.existsSync(CONFIG_FILE)) return;
    const cfg = loadConfig({ sessions: false }); // what is filled in so far, empty or not
    const hcThere = Boolean(findHc());
    // each session, and whether its hc core answers
    const here = sessionsHere();
    const sessionWords = [];
    for (const session of cfg.sessions) {
      if (!here.includes(session)) sessionWords.push(`${session} (no such session here; this machine has: ${here.join(', ') || 'none'})`);
      else sessionWords.push(`${session} (${(await coreUp(session)) ? 'core up' : 'core not running'})`);
    }
    console.log(`sessions  ${sessionWords.join(', ') || 'none yet: set HERDR_SESSIONS (`ls ~/.local/state/herdr-core` lists them)'}`);
    // how it runs: the service, an hc terminal, or not at all
    const svc = hcThere ? service() : null;
    if (!hcThere) {
      console.log('running   unknown: hc is not on PATH (install herdr-core: https://herdr.dev)');
    } else {
      const inTerminal = cfg.sessions.length ? (await terminalState(cfg.sessions[0])) === 'live' : false;
      if (svc?.installed()) {
        const st = svc.state();
        console.log(`running   ${st.running ? `yes, as the ${svc.kind} service ${svc.name}${st.pid ? ` (pid ${st.pid})` : ''}` : `no: the ${svc.kind} service ${svc.name} is stopped (\`herdrchat start${again}\`)`}`);
        const gone = svc.nodeGone();
        if (gone) console.log(`          the service runs ${gone}, which is gone (node moved): \`herdrchat install${again}\` again`);
        if (inTerminal) console.log(`          also in hc terminal ${places.terminal}: two bots; \`herdrchat start${again}\` keeps one`);
      } else {
        console.log(`running   ${inTerminal ? `yes, in hc terminal ${places.terminal} (session ${cfg.sessions[0]}); \`herdrchat install${again}\` makes it a service` : `no (\`herdrchat start${again}\`, or \`herdrchat install${again}\` for a service)`}`);
      }
    }
    // what its chat app needs, without printing a secret
    const set = (value, missing) => (value ? 'set' : missing);
    const owner = 'not set: message the bot, it says what to put in config.env';
    console.log(`chat      ${cfg.chat}`);
    if (cfg.chat === 'feishu') {
      let token = null;
      try {
        token = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'user-token.json'), 'utf8'));
      } catch {
        // no /auth yet
      }
      console.log(`app id    ${set(cfg.appId, 'missing: FEISHU_APP_ID, from the Feishu developer console')}`);
      console.log(`secret    ${set(cfg.appSecret, 'missing: FEISHU_APP_SECRET, from the Feishu developer console')}`);
      console.log(`owner     ${set(cfg.ownerOpenId, owner)}`);
      console.log(`/auth     ${!token ? 'not done (muting, labels and pins need it: send /auth to the bot)' : (token.refreshUntil || 0) > Date.now() ? 'done' : 'expired: send /auth to the bot again'}`);
    } else if (cfg.chat === 'telegram') {
      console.log(`token     ${set(cfg.env.TELEGRAM_BOT_TOKEN, 'missing: TELEGRAM_BOT_TOKEN, from @BotFather')}`);
      console.log(`owner     ${set(cfg.env.TELEGRAM_OWNER_ID, owner)}`);
    }
    const log = logFile();
    if (fs.existsSync(log)) {
      const text = fs.readFileSync(log, 'utf8');
      const count = (level, word) => { const n = (text.match(new RegExp(` ${level} `, 'g')) || []).length; return `${n} ${word}${n === 1 ? '' : 's'}`; };
      console.log(`today     ${count('ERROR', 'error')}, ${count('WARN', 'warning')} (herdrchat logs --errors${again})`);
    }
  },

  logs() {
    const log = logFile(day);
    if (!fs.existsSync(log)) {
      console.log(`No log for ${day || 'today'} (${log}).${day ? '' : ' Older days: --day YYYY-MM-DD.'}`);
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
  console.error(`Unknown command: ${command}\n`);
  console.error(USAGE);
  process.exit(2);
}
try {
  await commands[command]();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
