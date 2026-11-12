// Acting as you (user_access_token), for the few chat-list settings Feishu lets only you
// change: mute a group, put it in one of your feed groups (labels), pin it. You allow it
// once with the OAuth device flow (`/auth` in the direct chat), which needs no public address: the bot shows a link
// and a code, you confirm in Feishu, the bot polls for the token. The token is refreshed
// before it expires and kept in user-token.json in the state folder (mode 600), never logged.
// Only the calls in this file are made with it.
import fs from 'node:fs';
import path from 'node:path';

const ACCOUNTS = 'https://accounts.feishu.cn';
const OPEN = 'https://open.feishu.cn';
export const USER_SCOPES = ['im:chat.user_setting:write', 'im:feed_group_v1:read', 'im:feed_group_v1:write', 'im:feed.shortcut:write', 'offline_access'];
const EARLY_MS = 5 * 60 * 1000; // refresh this long before the token runs out

export function createUserAuth(cfg, dir) {
  const file = path.join(dir, 'user-token.json');
  const basic = Buffer.from(`${cfg.appId}:${cfg.appSecret}`).toString('base64');

  const load = () => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  };
  const save = (t) => {
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(t), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
  };
  const keep = (res) => {
    const now = Date.now();
    const old = load() || {};
    const t = {
      access: res.access_token,
      accessUntil: now + (res.expires_in || 7200) * 1000,
      refresh: res.refresh_token || old.refresh,
      refreshUntil: res.refresh_token ? now + (res.refresh_token_expires_in || 7 * 86400) * 1000 : old.refreshUntil,
      scope: res.scope || old.scope,
    };
    save(t);
    return t;
  };

  async function form(url, body, auth) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(auth ? { Authorization: `Basic ${basic}` } : {}) },
      body: new URLSearchParams(body),
    });
    return res.json();
  }

  // Step 1: a link and a code for you. Step 2 (`waitForToken`) polls until you confirm.
  async function startDeviceFlow() {
    const r = await form(`${ACCOUNTS}/oauth/v1/device_authorization`, { client_id: cfg.appId, scope: USER_SCOPES.join(' ') }, true);
    if (!r.device_code) throw new Error(`device authorization: ${JSON.stringify(r).slice(0, 200)}`);
    return r;
  }

  async function waitForToken(device) {
    let interval = (device.interval || 5) * 1000;
    const until = Date.now() + (device.expires_in || 240) * 1000;
    while (Date.now() < until) {
      await new Promise((ok) => setTimeout(ok, interval));
      const r = await form(`${ACCOUNTS}/oauth/v3/token`, {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: device.device_code,
        client_id: cfg.appId,
        client_secret: cfg.appSecret,
      });
      if (r.access_token) return keep(r);
      if (r.error === 'slow_down') interval += 5000;
      else if (r.error !== 'authorization_pending') throw new Error(`authorization: ${r.error || JSON.stringify(r).slice(0, 200)}`);
    }
    throw new Error('authorization: the code expired before it was confirmed');
  }

  async function token() {
    const t = load();
    if (!t?.access) return null;
    if (Date.now() < t.accessUntil - EARLY_MS) return t.access;
    if (!t.refresh || Date.now() > (t.refreshUntil || 0)) return null;
    const res = await fetch(`${ACCOUNTS}/oauth/v3/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: t.refresh, client_id: cfg.appId, client_secret: cfg.appSecret }),
    });
    const r = await res.json();
    if (!r.access_token) throw new Error(`token refresh: ${r.error || JSON.stringify(r).slice(0, 200)}`);
    return keep(r).access;
  }

  // One call as you; null when you have not allowed it (or it ran out).
  async function call(method, apiPath, body) {
    const access = await token();
    if (!access) return null;
    const res = await fetch(`${OPEN}${apiPath}`, {
      method,
      headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const r = await res.json();
    if (r.code) throw new Error(`${method} ${apiPath} ${r.code}: ${r.msg}`);
    return r.data || {};
  }

  return {
    startDeviceFlow,
    waitForToken,
    allowed: async () => Boolean(await token().catch(() => null)),
    setMuted: (chatIds, muted) => call('POST', '/open-apis/im/v1/chat_user_setting/batch_update', { chat_settings: chatIds.map((chat_id) => ({ chat_id, is_muted: muted })) }),
    feedGroups: () => call('GET', '/open-apis/im/v1/groups?page_size=50&page_token='),
    createFeedGroup: (name) => call('POST', '/open-apis/im/v1/groups', { feed_group_creator: { name, type: 'normal' } }),
    addToFeedGroup: (groupId, chatIds) => call('POST', `/open-apis/im/v1/groups/${groupId}/batch_add_item`, { items: chatIds.map((feed_id) => ({ feed_id, feed_type: 'chat' })) }),
    removeFromFeedGroup: (groupId, chatIds) => call('POST', `/open-apis/im/v1/groups/${groupId}/batch_remove_item`, { items: chatIds.map((feed_id) => ({ feed_id, feed_type: 'chat' })) }),
    pin: (chatId) => call('POST', '/open-apis/im/v2/feed_shortcuts', { is_header: true, shortcuts: [{ feed_card_id: chatId, type: 1 }] }),
    unpin: (chatId) => call('POST', '/open-apis/im/v2/feed_shortcuts/remove', { shortcuts: [{ feed_card_id: chatId, type: 1 }] }),
  };
}
