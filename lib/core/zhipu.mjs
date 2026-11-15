// Zhipu's GLM Coding Plan (and Z.ai's) limits, for the footer of any agent that runs on it
// (OpenCode, Pi): asked the way Zhipu's own usage plugin asks them (glm-plan-usage, in
// zai-org/zai-coding-plugins): GET <host>/api/monitor/usage/quota/limit with the plan's key
// as is (no "Bearer"). The key is the agent's own, held only for this request, never
// written or logged, and sent only to the host it is already used with. Anything not as
// expected (no key, a refusal, a team plan that wants more, a reply of another shape, no
// network) gives no limits: the footer leaves them out, never a made-up 0%.
import crypto from 'node:crypto';
import * as words from './words.mjs';

// The host for a provider: by its base URL when it is known, else by its name.
export function zhipuHost({ provider, baseUrl } = {}) {
  const url = String(baseUrl || '');
  if (/\bopen\.bigmodel\.cn\b|\bdev\.bigmodel\.cn\b/.test(url)) return 'open.bigmodel.cn';
  if (/\bapi\.z\.ai\b/.test(url)) return 'api.z.ai';
  if (url) return null;
  const p = String(provider || '');
  if (/^zhipuai(-|$)|^zai-.*-cn$/.test(p)) return 'open.bigmodel.cn';
  if (/^zai(-|$)/.test(p)) return 'api.z.ai';
  return null;
}

// {"success":true,"data":{"level":"max","limits":[{"type":"TOKENS_LIMIT","unit":3,"number":5,
// "percentage":44,"nextResetTime":1794757050850},{"type":"TIME_LIMIT","unit":5,…}]}} ->
// {plan: 'max', limits: [{name: '5-hour', used: 44, resetsAt}]}. Only the tokens' windows
// (TIME_LIMIT is the month's web tools, which do not stop the models); unit 3 is hours, 6 a
// week (number 1 or 7 has been seen for it); a unit not known here is left out.
export function zhipuUsageIn(reply) {
  if (!reply || reply.success === false || !Array.isArray(reply.data?.limits)) return undefined;
  const found = [];
  for (const l of reply.data.limits) {
    if (l?.type !== 'TOKENS_LIMIT' || !Number.isFinite(l.percentage)) continue;
    const name = l.unit === 3 && l.number > 0 ? `${l.number}-hour` : l.unit === 6 ? '7-day' : null;
    if (name) found.push({ name, used: l.percentage, hours: l.unit === 3 ? l.number : 168, ...(Number.isFinite(l.nextResetTime) ? { resetsAt: l.nextResetTime } : {}) });
  }
  const level = typeof reply.data.level === 'string' ? reply.data.level : undefined;
  return { plan: level, limits: found.sort((a, b) => a.hours - b.hours).map(({ hours, ...w }) => w) };
}
// the same, for the footer: [{name, used}], none when no window is named
export function zhipuLimitsIn(reply) {
  const limits = zhipuUsageIn(reply)?.limits.map(({ name, used }) => ({ name, used }));
  return limits?.length ? limits : undefined;
}

const WAIT_MS = 15 * 1000;
async function ask(host, key, fetchImpl) {
  const res = await fetchImpl(`https://${host}/api/monitor/usage/quota/limit`, { headers: { Authorization: key, 'Accept-Language': 'en-US,en' }, signal: AbortSignal.timeout(WAIT_MS) });
  return res.ok ? res.json().catch(() => null) : null;
}
export async function askZhipuLimits(host, key, fetchImpl = globalThis.fetch) {
  if (!host || !key) return undefined;
  return zhipuLimitsIn(await ask(host, key, fetchImpl));
}

// For /usage in the direct chat: the plan a key is on, as an account (readers/index.mjs,
// usage). `via`: the agent the key was found in. One key is one account, wherever it is
// found: it is told apart by a hash of it, never by the key itself.
export async function zhipuAccount(host, key, via, fetchImpl = globalThis.fetch) {
  const found = zhipuUsageIn(await ask(host, key, fetchImpl).catch(() => null));
  return {
    id: `zhipu|${host}|${crypto.createHash('sha256').update(key).digest('hex').slice(0, 16)}`,
    app: host === 'api.z.ai' ? 'Z.ai Coding Plan' : 'GLM Coding Plan',
    plan: found?.plan,
    limits: found?.limits || [],
    via: [via],
    ...(found?.limits.length ? {} : { note: found ? words.NO_LIMITS_NAMED : words.NOT_ANSWERED }),
  };
}
