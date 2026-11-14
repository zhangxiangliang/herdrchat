// What a post's footer says beyond the harness and model: the git branch, how full the
// context is, and the account's limits. Numbers that cost a command to learn (a model's
// context window, an account's 5-hour and 7-day limits) are given as last known, at once;
// a new reading is asked for in the background once the last is older than its time, so a
// post waits on one only the first time (knownSoon), and then only for seconds.

import { shellQuote } from './shell.mjs';

const known = new Map(); // key -> {value, at, asking}

// The last value `ask()` gave for `key` (undefined before the first), asking again in the
// background once it is older than `maxAgeMs`. A failed ask keeps the last value and is
// not tried again before `maxAgeMs` either.
export function lastKnown(key, maxAgeMs, ask, now = Date.now()) {
  let k = known.get(key);
  if (!k) known.set(key, (k = { value: undefined, at: -Infinity, asking: null })); // never asked: asked now
  if (!k.asking && now - k.at > maxAgeMs) {
    k.asking = Promise.resolve()
      .then(ask)
      .then((v) => { if (v !== undefined && v !== null) k.value = v; })
      .catch(() => {})
      .finally(() => { k.at = Date.now(); k.asking = null; });
  }
  return k.value;
}

// How old a reading may be: a model's window (or the list it comes from) changes seldom;
// an account's limits change with every request. The first reading is waited for this long.
export const WINDOW_MS = 24 * 60 * 60 * 1000;
export const LIMITS_MS = 5 * 60 * 1000;
export const FIRST_WAIT_MS = 10 * 1000;

// The same, but the first time (nothing known yet) it waits for the reading, up to
// `waitMs`: a post after a restart then has it too, a few seconds later, once.
export async function knownSoon(key, maxAgeMs, ask, waitMs = FIRST_WAIT_MS) {
  const value = lastKnown(key, maxAgeMs, ask);
  const k = known.get(key);
  if (value !== undefined || !k.asking) return value;
  let timer;
  await Promise.race([k.asking, new Promise((ok) => { timer = setTimeout(ok, waitMs); })]);
  clearTimeout(timer);
  return k.value;
}

// For tests: forget every reading, or wait for the ones being asked.
export const forgetAll = () => known.clear();
export const asked = () => Promise.all([...known.values()].map((k) => k.asking).filter(Boolean));

// 234480 -> "234k", 1404175 -> "1.4M"
export function tokens(n) {
  if (n < 1000) return String(n);
  if (n < 1e6) return `${Math.round(n / 1000)}k`;
  return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
}

// A limit's name from how long its window runs: 300 minutes -> "5-hour", 10080 -> "7-day".
export function windowName(minutes) {
  return minutes % 1440 === 0 ? `${minutes / 1440}-day` : minutes % 60 === 0 ? `${minutes / 60}-hour` : `${minutes}-minute`;
}

// A share in percent, as people read it: whole, but a share under 1% with one decimal
// (0.3% of a 1M window is not "0%"), and never 0% for something there.
export function percent(share) {
  const p = share * 100;
  if (p >= 1 || p <= 0) return `${Math.round(p)}%`;
  return `${Math.max(0.1, Math.round(p * 10) / 10)}%`;
}

// The branch the folder is on, through a shell on its machine (`shell(script)`): its name,
// or its short commit when it is on none; empty when it is not in a git repository.
export async function branchOf(shell, cwd) {
  if (!cwd) return '';
  const out = await shell(`cd ${shellQuote(cwd)} 2>/dev/null && { git branch --show-current 2>/dev/null | grep . || git rev-parse --short HEAD 2>/dev/null; }`);
  return String(out || '').trim().split('\n')[0] || '';
}
