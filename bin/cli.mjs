#!/usr/bin/env node
// herdrchat's command line: set up, start, stop and look at one profile.
//
//   herdrchat <command> [--profile <name>]
//     setup      a few questions, and it is set up, started, paired with you and kept running
//     init       make the profile's config.env from the example when it is missing
//     install    run it as a service of the system (launchd, systemd): it starts at
//                login and comes back after a crash; start, stop, status go through it
//     uninstall  no service any more (it is stopped)
//     start      start (or restart) it: the service, or else its own hc terminal
//     stop       stop it
//     status     how it runs, its folders, sessions, its chat app, errors today
//     logs       today's log (-n <lines>, --errors for ERROR and WARN only, --day <date>)
//     run        run in the foreground (what start keeps running)
//     hooks      herdrchat's hook in Claude Code's and Codex's settings: status, install, uninstall
//     update     the latest herdrchat from npm (or `update 1.2.3`: that one); running bots
//                start again on it by themselves
//     version    which herdrchat this is
//
// The profile is --profile or HERDRCHAT_PROFILE (default "default"); where its files are
// is in lib/core/config.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GUIDE = 'https://github.com/zhangxiangliang/herdrchat/blob/main/docs/guide.md';
const HERDR = 'herdrchat is built on herdr: it mirrors the terminals that hc (herdr-core) runs.\nIt needs hc on this machine: install herdr first, from https://herdr.dev\n(or ask your coding agent `/herdrchat setup`: it can install herdr with you).';
const USAGE = `herdrchat: the chat client for hc (herdr), in Feishu or Telegram. Needs hc (https://herdr.dev).

herdrchat <command> [--profile <name>]

  setup      set it up by answering a few questions (the easy way in)
  pair       make you the bot's owner: it shows a code to send to the bot
  init       make the profile's config.env (--chat feishu|telegram picks the app)
  start      start (or restart) it: the service, or else its own hc terminal
  stop       stop it
  status     how it runs, its folders, sessions, its chat app, errors today
  logs       today's log (-n <lines>, --errors for ERROR and WARN only, --day <date>)
  install    run it as a service of the system: starts at login, back after a crash
  uninstall  no service any more (it is stopped)
  run        run in the foreground (what start keeps running)
  hooks      what Claude Code and Codex ask you comes to the chat in their own words, and
             your answer goes back to them: hooks install (asks first) | uninstall
  update     the latest herdrchat from npm, with its skill and hook; running bots start
             again on it by themselves (update 1.2.3: that version, to go back)
  version    which herdrchat this is

First time: herdrchat setup. (Or by hand: herdrchat init, fill in the file, herdrchat start.)
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
const { CONFIG_FILE, STATE_DIR, chatOf, loadConfig, makeDirs, placesOf, readState, setConfigValue, writeState } = await import('../lib/core/config.mjs');
const { startPairing, PAIR_MINUTES } = await import('../lib/core/pairing.mjs');
const { chatModule, chatNames } = await import('../lib/chats/index.mjs');
const { coreUp, hc, sessionsHere } = await import('../lib/core/hc.mjs');
const { serviceOf } = await import('../lib/core/service.mjs');
const places = placesOf();

const { shellQuote } = await import('../lib/core/shell.mjs');
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
  if (unknown.length) {
    const what = cfg.sessionsSet ? `HERDR_SESSIONS in ${CONFIG_FILE} names ${unknown.join(', ')}, which ${unknown.length > 1 ? 'are' : 'is'} not an hc session on this machine` : `HERDR_SESSIONS is empty, so herdrchat follows hc's default session, which is not on this machine`;
    fail(`${what}.\nThe sessions here: ${here.join(', ') || 'none: install and start herdr first (https://herdr.dev)'}.${here.length ? ` Put the ones to mirror in HERDR_SESSIONS in ${CONFIG_FILE}.` : ''}`, 1);
  }
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
  if (!hcPath) throw new Error(`hc is not on PATH. ${HERDR}`);
  // HERDRCHAT_KEPT: something starts it again when it stops (the service, or the loop
  // `start` runs it in), so it may stop to run new code after an update
  const env = { HERDRCHAT_HC: hcPath, HERDRCHAT_PROFILE: places.profile, HERDRCHAT_KEPT: '1' };
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

// ---------- setup: questions instead of a file to fill ----------

async function prompter() {
  const readline = await import('node:readline/promises');
  let rl = null;
  const open = () => { rl ||= readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true }); return rl; };
  const shut = () => { rl?.close(); rl = null; };
  const ask = async (q, fallback = '') => (await open().question(fallback ? `${q} [${fallback}] ` : `${q} `)).trim() || fallback;
  // A token or a secret is typed with nothing shown, not even dots: the terminal is put in
  // raw mode and each key is read here, so neither the terminal nor readline echoes it.
  const askSecret = (q) => new Promise((resolve) => {
    shut();
    process.stdout.write(`${q} `);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    let value = '';
    const onData = (buf) => {
      for (const ch of buf.toString('utf8')) {
        if (ch === '\u0003') { // Ctrl+C
          stdin.setRawMode(false);
          process.stdout.write('\n');
          process.exit(130);
        }
        if (ch === '\r' || ch === '\n' || ch === '\u0004') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          resolve(value.trim());
          return;
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    };
    stdin.on('data', onData);
  });
  return { ask, askSecret, close: shut };
}

const ok = (text) => console.log(`✔ ${text}`);
const bad = (text) => console.log(`✘ ${text}`);
const tell = (text) => console.log(`  ${text}`);

async function telegramMe(token) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: AbortSignal.timeout(15000) });
    const body = await res.json();
    return body.ok ? body.result : { error: body.description || `HTTP ${res.status}` };
  } catch (err) {
    return { error: err.message };
  }
}

async function feishuCheck(appId, appSecret) {
  try {
    const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ app_id: appId, app_secret: appSecret }), signal: AbortSignal.timeout(15000) });
    const body = await res.json();
    return body.code === 0 ? { ok: true } : { error: body.msg || `code ${body.code}` };
  } catch (err) {
    return { error: err.message };
  }
}

const commands = {
  async setup() {
    if (!process.stdin.isTTY) fail(`herdrchat setup asks questions, so run it in a terminal. Without one: herdrchat init${again}, fill in the file, herdrchat start${again}.`);
    console.log(`herdrchat setup${again}: a few questions, then it runs.\n`);
    // 1. herdr
    const hcPath = findHc();
    if (!hcPath) {
      bad(`hc is not on PATH. ${HERDR}`);
      process.exitCode = 1;
      return;
    }
    const { execFileSync } = await import('node:child_process');
    ok(`herdr is here (${execFileSync(hcPath, ['--version'], { encoding: 'utf8' }).trim()})`);
    const p = await prompter();
    try {
      // 2. the chat app
      makeDirs();
      const had = fs.existsSync(CONFIG_FILE) ? loadConfig() : null;
      let chatName = chatFlag || had?.chat;
      if (!chatName || (!had && !chatFlag)) {
        const pick = await p.ask('Which chat app? 1) Feishu  2) Telegram', had?.chat === 'telegram' ? '2' : '1');
        chatName = pick === '2' || /^t/i.test(pick) ? 'telegram' : 'feishu';
      }
      if (!had) {
        const example = fs.readFileSync(path.join(ROOT, 'config.env.example'), 'utf8').replace(/^HERDRCHAT_CHAT=.*$/m, `HERDRCHAT_CHAT=${chatName}`);
        fs.writeFileSync(CONFIG_FILE, example, { mode: 0o600 });
      } else {
        setConfigValue(CONFIG_FILE, 'HERDRCHAT_CHAT', chatName);
      }
      ok(`${chatName}, settings in ${CONFIG_FILE}`);
      const env = loadConfig().env;
      // 3. its keys, checked now
      if (chatName === 'telegram') {
        let token = env.TELEGRAM_BOT_TOKEN || '';
        if (!token) tell('Make a bot first: in Telegram, message @BotFather, send /newbot, pick a name; it gives you a token.');
        for (;;) {
          if (!token) token = await p.askSecret('Paste the token (it is not shown):');
          const me = await telegramMe(token);
          if (me.error) {
            bad(`Telegram says: ${me.error}. Check the token and paste it again.`);
            token = '';
            continue;
          }
          setConfigValue(CONFIG_FILE, 'TELEGRAM_BOT_TOKEN', token);
          ok(`the token works: @${me.username}`);
          if (!me.has_topics_enabled) {
            bad('topic mode is off, and herdrchat makes one topic per terminal.');
            tell('In the @BotFather chat tap Open (its mini app), pick your bot, turn on Threaded Mode.');
            await p.ask('Press Enter when it is on.');
            continue;
          }
          ok('topic mode is on');
          break;
        }
      } else {
        let appId = env.FEISHU_APP_ID || '';
        let appSecret = env.FEISHU_APP_SECRET || '';
        if (!appId || !appSecret) {
          tell('Make the Feishu app first, in https://open.feishu.cn/app: a custom app (企业自建应用) with the bot ability');
          tell('and the scopes in the guide, "Set up: Feishu": ' + GUIDE + '#set-up-feishu');
          tell('(your coding agent can click through it for you: /herdrchat feishu create the app)');
        }
        for (;;) {
          if (!appId) appId = await p.ask('App ID (cli_…, on the app\'s 凭证与基础信息 page):');
          if (!appSecret) appSecret = await p.askSecret('App Secret (it is not shown):');
          const check = await feishuCheck(appId, appSecret);
          if (check.error) {
            bad(`Feishu says: ${check.error}. Check the App ID and Secret and give them again.`);
            appId = '';
            appSecret = '';
            continue;
          }
          setConfigValue(CONFIG_FILE, 'FEISHU_APP_ID', appId);
          setConfigValue(CONFIG_FILE, 'FEISHU_APP_SECRET', appSecret);
          ok('the App ID and Secret work');
          break;
        }
      }
      // 4. which sessions
      const here = sessionsHere();
      if (!here.length) {
        bad('herdr is installed but no hc session runs on this machine, so there is nothing to mirror yet.');
        tell('Open herdr-app, or start hc as herdr\'s docs say (https://herdr.dev), then run herdrchat setup' + again + ' again: what is done so far is kept.');
        process.exitCode = 1;
        return;
      }
      const named = loadConfig().sessionsSet ? loadConfig().sessions.join(',') : '';
      const fallback = named || (here.includes('default') ? 'default' : here[0] || 'default');
      tell(`hc sessions on this machine: ${here.join(', ') || 'none yet'}. "default" with herdr-app reaches all it shows.`);
      for (;;) {
        const pick = (await p.ask('Which sessions to mirror (comma-separated)?', fallback)).split(',').map((x) => x.trim()).filter(Boolean);
        const unknown = pick.filter((x) => !here.includes(x));
        if (unknown.length) {
          bad(`not on this machine: ${unknown.join(', ')}`);
          continue;
        }
        setConfigValue(CONFIG_FILE, 'HERDR_SESSIONS', pick.join(',') === 'default' ? '' : pick.join(','));
        ok(`following ${pick.join(', ')}`);
        break;
      }
      // 5. start
      console.log('');
      await commands.start();
      if (process.exitCode) return;
      if (chatName === 'feishu') {
        tell('Now, with the bot running, in the Feishu developer console: 事件与回调 -> long connection (长连接),');
        tell('add the event im.message.receive_v1 and the callback card.action.trigger, then publish a version.');
        await p.ask('Press Enter when the version is published.');
      }
      // 6. pair: the owner is whoever sends the code (the same step the agent runs)
      await commands.pair();
      if (process.exitCode) return;
      // 7. keep it running
      const svc = service();
      if (svc && !svc.installed()) {
        const yes = await p.ask('Keep it running as a service (starts at login, comes back after a crash)? [Y/n]', 'Y');
        if (/^y/i.test(yes)) await commands.install();
      }
      console.log(`\nDone. herdrchat status${again} shows how it is; herdrchat logs${again} what it did.`);
      if (chatName === 'feishu') console.log('Send /auth to the bot once to let it mute its groups, so your phone rings only when it should.');
    } finally {
      p.close();
    }
  },

  // The owner, without copying an id: a 6-digit code sent to the bot. It needs no terminal,
  // so `herdrchat setup` and the agent's `/herdrchat setup` both use it. Sending the code
  // also proves the whole path works: the bot runs, the chat app delivers, events are on.
  async pair() {
    const cfg = loadConfig();
    const ownerKey = cfg.chat === 'telegram' ? 'TELEGRAM_OWNER_ID' : 'FEISHU_OWNER_OPEN_ID';
    if (cfg.env[ownerKey]) {
      ok(`the owner is set already (${ownerKey} in ${CONFIG_FILE}); to change it, empty that line and pair again`);
      return;
    }
    const svc = service();
    const running = svc?.installed() ? svc.state().running : (await terminalState(cfg.sessions[0])) === 'live';
    if (!running) fail(`The bot is not running, and it is the bot that reads the code. Run herdrchat start${again} first.`);
    let where = 'your chat with the bot';
    if (cfg.chat === 'telegram') {
      const me = await telegramMe(cfg.env.TELEGRAM_BOT_TOKEN || '');
      if (me.username) where = `your chat with @${me.username} (https://t.me/${me.username}), tap Start if Telegram shows it,`;
    } else {
      where = 'your chat with the bot (in Feishu, search the app\'s name, open it, and message it)';
    }
    const code = startPairing({ read: readState, write: writeState });
    console.log(`\nOpen ${where} and send it this code:\n\n      ${code}\n`);
    tell(`It works for ${PAIR_MINUTES} minutes. Waiting…`);
    const since = new Date().toISOString();
    const until = Date.now() + PAIR_MINUTES * 60 * 1000;
    while (Date.now() < until && !loadConfig().env[ownerKey]) await new Promise((r) => setTimeout(r, 2000));
    if (!loadConfig().env[ownerKey]) {
      bad(`no code came in ${PAIR_MINUTES} minutes. Run herdrchat pair${again} for a new one.`);
      if (cfg.chat === 'feishu') tell('When the bot never answered at all: in the developer console, check the event im.message.receive_v1 is added on the long connection, and that a version with it is published.');
      else tell('When the bot never answered at all: herdrchat logs' + again + ' says why.');
      process.exitCode = 1;
      return;
    }
    ok('paired: you are the owner. It starts again as yours…');
    const back = await waitConnected(since);
    if (!back.ok) return failedToConnect('It paired', back);
    ok(`connected; your terminals' ${cfg.chat === 'telegram' ? 'topics' : 'groups'} appear in a moment`);
  },

  init() {
    const chatName = chatFlag || 'feishu';
    if (!chatNames().includes(chatName)) fail(`--chat ${chatName}: the chat apps are ${chatNames().join(', ')}`);
    // the settings can be made first, but nothing works without herdr: said before anything
    if (!findHc()) console.log(`⚠️  hc is not on PATH. ${HERDR}\n`);
    makeDirs();
    if (fs.existsSync(CONFIG_FILE)) {
      console.log(`${CONFIG_FILE} is there already; open it and edit it, then run \`herdrchat start${again}\`.`);
      return;
    }
    const example = fs.readFileSync(path.join(ROOT, 'config.env.example'), 'utf8').replace(/^HERDRCHAT_CHAT=.*$/m, `HERDRCHAT_CHAT=${chatName}`);
    fs.writeFileSync(CONFIG_FILE, example, { mode: 0o600 });
    const keys = (chatModule(chatName).requires || []).join(', ');
    console.log(`Made ${CONFIG_FILE} (only you can read it) for ${chatName}.\nOpen it and fill in ${keys} (HERDR_SESSIONS is hc's default session unless you name others), then run \`herdrchat start${again}\`.\nThe guide walks through it: ${GUIDE}`);
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
    console.log(`sessions  ${sessionWords.join(', ')}${cfg.sessionsSet ? '' : ' (hc\'s default session: HERDR_SESSIONS is empty)'}`);
    // how it runs: the service, an hc terminal, or not at all
    const svc = hcThere ? service() : null;
    if (!hcThere) {
      console.log('running   unknown: hc is not on PATH; herdrchat is built on herdr: install it from https://herdr.dev');
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

  // For every profile at once: one install, and each running bot sees it and starts again.
  async update() {
    const { update } = await import('../lib/core/update.mjs');
    const { refreshHook } = await import('../lib/core/hooks.mjs');
    const [, version = 'latest'] = argv.filter((a) => !a.startsWith('-'));
    console.log(version === 'latest' ? 'Looking for the latest herdrchat on npm…' : `Installing herdrchat ${version}…`);
    const result = await update({ version, root: ROOT, refreshHook });
    for (const line of result.lines) (result.ok ? tell : bad)(line);
    if (!result.ok) {
      process.exitCode = 1;
      return;
    }
    if (result.changed) tell('Running bots start again on it by themselves within a minute; a bot run by hand (herdrchat run) needs a restart.');
  },

  // One hook for every profile: it is in the agents' settings, for this machine's user.
  async hooks() {
    const { hooksStatus, installHooks, uninstallHooks } = await import('../lib/core/hooks.mjs');
    const [, sub = 'status', ...only] = argv.filter((a) => !a.startsWith('-'));
    const status = hooksStatus();
    if (sub === 'status') {
      for (const a of status) console.log(`${a.name.padEnd(12)} ${!a.there ? `not here (${a.dir})` : a.in ? `in (${a.file})` : 'not in: herdrchat hooks install'}`);
      console.log('\nWith the hook, what they ask you (permissions, questions, plans) comes to the chat in their\nown words and options, and your answer goes straight back; without it, the screen is read.');
      return;
    }
    if (sub === 'uninstall') {
      const done = uninstallHooks();
      if (!done.length) console.log('The hook was not in; nothing changed.');
      for (const line of done) ok(`taken out: ${line}`);
      return;
    }
    if (sub !== 'install') fail('herdrchat hooks: status (default), install [claude|codex|pi] or uninstall');
    const AGENTS = ['claude', 'codex', 'pi'];
    const wanted = only.length ? only : AGENTS;
    const unknown = wanted.filter((w) => !AGENTS.includes(w));
    if (unknown.length) fail(`herdrchat hooks install: ${unknown.join(', ')}? Name claude, codex or pi (or none: all of them).`);
    const picked = status.filter((a) => wanted.includes(a.agent) && a.there);
    if (!picked.length) fail(`Neither of ${wanted.join(', ')} is set up here (no ${status.filter((a) => wanted.includes(a.agent)).map((a) => a.dir).join(', ')}).`);
    console.log('herdrchat adds:');
    for (const a of picked) tell(a.extension ? `${a.name}: ${a.file} (a Pi extension of its own: it tells herdrchat which session file each pi writes)` : `${a.name}: ${a.file} (PermissionRequest; a copy of the file is kept first)`);
    const asking = picked.filter((a) => !a.extension);
    if (picked.some((a) => a.extension)) console.log(`
With the Pi extension, each pi labels its hc terminal with its session file, so two pi in
one folder are told apart (without it, both rooms follow the folder's newest session).${asking.length ? '' : '\nTake it out any time: herdrchat hooks uninstall'}`);
    if (asking.length) console.log(`
With it, when ${asking.map((a) => a.name).join(' or ')} asks you something in an hc terminal (a permission,
a question, a plan), the card in your chat shows its own words and options, and your
answer goes straight back to it. The terminal still works: answer there and the card closes.
Claude Code shows its prompt as usual. Codex shows its prompt only once the hook is done: tap
"Answer in the terminal" on the card, or after 10 minutes it comes back to the terminal by itself.
Take it out any time: herdrchat hooks uninstall`);
    if (!argv.includes('--yes')) {
      if (!process.stdin.isTTY) fail('\nAdd --yes to put it in without being asked.');
      const p = await prompter();
      const yes = /^y(es)?$/i.test(await p.ask('\nPut it in? (y/N)', 'N'));
      p.close();
      if (!yes) {
        console.log('Nothing changed.');
        return;
      }
    }
    for (const line of installHooks(picked.map((a) => a.agent))) ok(`in: ${line}`);
    if (picked.some((a) => a.agent === 'claude')) tell('Claude Code: sessions started from now on use it (restart one that runs now).');
    if (picked.some((a) => a.agent === 'codex')) tell('Codex: it asks you once to trust a new hook: in Codex, open /hooks and trust herdrchat\'s.');
    if (picked.some((a) => a.agent === 'pi')) tell('Pi: sessions started from now on use it (in a pi that runs now: /reload).');
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
