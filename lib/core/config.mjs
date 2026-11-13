// Where herdrchat keeps things. Several can run side by side, one per profile
// (HERDRCHAT_PROFILE, `default` when unset), each with its own folders and hc terminal:
//   ~/.config/herdrchat/<profile>/config.env   your settings, below (XDG_CONFIG_HOME moves it)
//   ~/.local/state/herdrchat/<profile>/        what the bot writes (XDG_STATE_HOME moves it):
//     state.json (per terminal, its group and what was posted from it; tag and label ids),
//     user-token.json (your token after /auth), logs/
// HERDRCHAT_HOME puts one profile in one folder of your choice instead: config.env and
// state/ inside it. The folders are made private (mode 700). The settings in config.env:
//   HERDRCHAT_CHAT                   the chat app: feishu (default); its keys follow
//   FEISHU_APP_ID, FEISHU_APP_SECRET  herdrchat's Feishu app
//   FEISHU_OWNER_OPEN_ID             your open_id for that app; the only person it listens to
//   TELEGRAM_BOT_TOKEN               herdrchat's Telegram bot (topic mode on, in @BotFather)
//   TELEGRAM_OWNER_ID                your Telegram user id; the only person it listens to
//   HERDR_SESSIONS                   hc sessions to mirror, comma-separated
//   HERDR_MUTED_SPACES               spaces whose groups are muted once /auth is done (only
//                                    an @ rings there): `all` (default), empty for none, or
//                                    spaces, comma-separated
//   HERDR_SILENT_SPACES              spaces that do not even @-mention you (fully quiet):
//                                    empty (default) for none, `all`, or spaces
//   HERDR_BOT_TAGS                   `on` (default) or `off`: the bot's tags next to group
//                                    names (tenant tags: session or machine, and "ended")
//   HERDR_USER_TAGS                  `on` (default) or `off`: your sidebar labels, once
//                                    /auth is done
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Where one profile lives, from the environment: {profile, configDir, stateDir, terminal}.
export function placesOf(env = process.env, home = os.homedir()) {
  const profile = env.HERDRCHAT_PROFILE || 'default';
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(profile)) throw new Error(`HERDRCHAT_PROFILE "${profile}": letters, digits, - and _ only`);
  const terminal = profile === 'default' ? 'herdrchat' : `herdrchat-${profile}`;
  if (env.HERDRCHAT_HOME) return { profile, configDir: env.HERDRCHAT_HOME, stateDir: path.join(env.HERDRCHAT_HOME, 'state'), terminal };
  const configRoot = env.XDG_CONFIG_HOME || path.join(home, '.config');
  const stateRoot = env.XDG_STATE_HOME || path.join(home, '.local', 'state');
  return { profile, configDir: path.join(configRoot, 'herdrchat', profile), stateDir: path.join(stateRoot, 'herdrchat', profile), terminal };
}

const places = placesOf();
export const CONFIG_DIR = places.configDir;
export const STATE_DIR = places.stateDir;
export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.env');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
// Made when the bot starts, not when this is imported (a test must not touch your home).
export function makeDirs() {
  for (const dir of [CONFIG_DIR, STATE_DIR]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function parseEnv(file) {
  const env = {};
  if (!fs.existsSync(file)) return env;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return env;
}

// A list of spaces: `all`, empty or `none` for none, or the spaces listed. `fallback` is
// what an unset variable means.
export function spacesOf(value, fallback) {
  const v = (value ?? fallback).trim();
  if (v === 'all') return { all: true, spaces: [] };
  if (v === '' || v === 'none') return { all: false, spaces: [] };
  return { all: false, spaces: v.split(',').map((s) => s.trim()).filter(Boolean) };
}

// on / off (also true, yes, 1 / false, no, 0); `fallback` is what an unset variable means.
export function onOff(value, fallback) {
  const v = String(value ?? '').trim().toLowerCase();
  if (['on', 'true', 'yes', '1'].includes(v)) return true;
  if (['off', 'false', 'no', '0'].includes(v)) return false;
  return fallback;
}

// `requires`: config keys the chat app cannot start without (its module's `requires`).
// `env` is everything config.env and the environment hold, for the app's own keys.
export function loadConfig({ requires = [] } = {}) {
  const env = { ...parseEnv(CONFIG_FILE), ...process.env };
  const sessions = (env.HERDR_SESSIONS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const missing = requires.filter((k) => !env[k]);
  if (missing.length) throw new Error(`${CONFIG_FILE}: ${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} required`);
  if (!sessions.length) throw new Error(`${CONFIG_FILE}: HERDR_SESSIONS must list at least one hc session`);
  return {
    chat: env.HERDRCHAT_CHAT || 'feishu',
    env,
    sessions,
    appId: env.FEISHU_APP_ID || '',
    appSecret: env.FEISHU_APP_SECRET || '',
    ownerOpenId: env.FEISHU_OWNER_OPEN_ID || '',
    muted: spacesOf(env.HERDR_MUTED_SPACES, 'all'),
    silent: spacesOf(env.HERDR_SILENT_SPACES, ''),
    botTags: onOff(env.HERDR_BOT_TAGS, true),
    userTags: onOff(env.HERDR_USER_TAGS, true),
  };
}

// The chat app config.env names, before its keys are checked.
export function chatOf() {
  return ({ ...parseEnv(CONFIG_FILE), ...process.env }).HERDRCHAT_CHAT || 'feishu';
}

export function readState() {
  try {
    return { chats: {}, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) };
  } catch {
    return { chats: {} };
  }
}

export function writeState(state) {
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}
