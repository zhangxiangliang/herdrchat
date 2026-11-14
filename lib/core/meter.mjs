// What a post's footer says beyond the harness and model: the git branch, how full the
// context is, and the account's limits. Numbers that cost a command to learn (a model's
// context window, an account's 5-hour and 7-day limits) are given as last known, at once;
// a new reading is asked for in the background once the last is older than its time, so a
// post never waits on one. The first post may go without them.

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

// The footer's words: {app, model, branch, context: {used, size}, limits: [{name, used}],
// screen} -> "claude-code · claude-opus-5-5 · main · context 23% (234k) · 5-hour 2% · 7-day 57%".
// What is not known is left out.
export function footerWords({ app, model, screen, branch, context, limits } = {}) {
  const parts = [app, screen ? 'screen' : model, branch];
  if (context?.used) parts.push(context.size ? `context ${Math.round((context.used / context.size) * 100)}% (${tokens(context.used)})` : `context ${tokens(context.used)}`);
  for (const l of limits || []) if (Number.isFinite(l.used)) parts.push(`${l.name} ${Math.round(l.used)}%`);
  return parts.filter(Boolean).join(' · ');
}

// The branch the folder is on, through a shell on its machine (`shell(script)`): its name,
// or its short commit when it is on none; empty when it is not in a git repository.
const quote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
export async function branchOf(shell, cwd) {
  if (!cwd) return '';
  const out = await shell(`cd ${quote(cwd)} 2>/dev/null && { git branch --show-current 2>/dev/null | grep . || git rev-parse --short HEAD 2>/dev/null; }`);
  return String(out || '').trim().split('\n')[0] || '';
}
