// What leaves for the chat app is hidden where it looks like a secret: the chat app's
// servers keep what is posted, and its tenant's admins may read it. Only what has a clear
// shape is hidden (a key's own prefix, a private key block, a value given to a name that
// says secret, a password in a URL), never a guess at "random-looking" text: a commit id or
// a UUID looks like that too. The bot's own secrets (config.env) and the words you list
// (HERDR_REDACT_WORDS) are hidden wherever they are. A safety net, not a guarantee: a
// password said in plain words, or one in an image, still goes.

const HIDDEN = (what) => `[hidden: ${what}]`;
// a value once hidden is not hidden again
const NOT_HIDDEN = '(?!\\[hidden)';

// [name, pattern, replacement (default: the whole match)]
const SHAPES = [
  ['private key', /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g],
  ['Anthropic key', /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
  ['OpenAI key', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/g],
  ['GitLab token', /\bglpat-[A-Za-z0-9_-]{20,}/g],
  ['Slack token', /\bxox[abposr]-[A-Za-z0-9-]{10,}/g],
  ['AWS key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['Google key', /\bAIza[0-9A-Za-z_-]{35}/g],
  ['Stripe key', /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{20,}/g],
  ['npm token', /\bnpm_[A-Za-z0-9]{36}\b/g],
  ['Telegram token', /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g],
  ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
  // a header: its name stays
  ['token', new RegExp(`\\b(Bearer|Basic)\\s+${NOT_HIDDEN}[A-Za-z0-9._~+/=-]{16,}`, 'gi'), (m, scheme) => `${scheme} ${HIDDEN('token')}`],
  // a URL's password: the rest of the URL stays
  ['password', new RegExp(`\\b([a-z][a-z0-9+.-]*://[^\\s:@/]+:)${NOT_HIDDEN}([^\\s@/]{3,})@`, 'gi'), (m, head) => `${head}${HIDDEN('password')}@`],
  // a value given to a name that says secret (API_KEY=…, "password": "…", token: …): the
  // name stays; a number alone is a count (max_tokens: 4096), not a secret
  ['secret', new RegExp(`\\b([A-Za-z0-9_.-]*(?:secret|token|password|passwd|pwd|api[_-]?key|access[_-]?key|private[_-]?key|credential)[A-Za-z0-9_.-]*)(["']?\\s*[:=]\\s*)(["']?)${NOT_HIDDEN}(?!\\d+\\3(?:[\\s,;}]|$))([^\\s"'\`,;]{6,})\\3`, 'gi'), (m, name, sep, quote) => `${name}${sep}${quote}${HIDDEN('secret')}${quote}`],
];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// cfg: {redact (on), redactWords: [], env}. -> redact(text) -> {text, hits: [what]}
export function createRedactor(cfg = {}) {
  if (cfg.redact === false) return () => null;
  // the bot's own secrets, as they are written in config.env
  const own = Object.entries(cfg.env || {})
    .filter(([k, v]) => /(SECRET|TOKEN|PASSWORD|KEY)$/.test(k) && typeof v === 'string' && v.trim().length >= 8)
    .map(([, v]) => v.trim());
  const literals = [
    ...own.map((v) => ['secret', new RegExp(escapeRe(v), 'g')]),
    ...(cfg.redactWords || []).filter(Boolean).map((w) => ['word', new RegExp(escapeRe(w), 'gi')]),
  ];
  return (text) => {
    if (typeof text !== 'string' || !text) return null;
    let out = text;
    const hits = [];
    for (const [what, re, replace] of [...literals, ...SHAPES]) {
      out = out.replace(re, (...m) => {
        hits.push(what);
        return replace ? replace(...m) : HIDDEN(what);
      });
    }
    return hits.length ? { text: out, hits } : null;
  };
}

// Every string in a value (blocks, a look, a dialog, rows, notes), hidden where it should
// be; a Buffer is taken as text (a file of the conversation). Ids and refs have no such
// shape, so they come back as they were. -> {value, hits}
export function redactValue(redact, value) {
  const hits = [];
  const walk = (v) => {
    if (typeof v === 'string') {
      const r = redact(v);
      if (!r) return v;
      hits.push(...r.hits);
      return r.text;
    }
    if (Buffer.isBuffer(v)) {
      const r = redact(v.toString('utf8'));
      if (!r) return v;
      hits.push(...r.hits);
      return Buffer.from(r.text);
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return { value: walk(value), hits };
}

// The chat app's members that carry what is said out to it (names, posts, cards, dialogs,
// files, the overview); each of their arguments is hidden where it should be before it
// goes. Every other member carries no words of an agent's (ids, marks, images, what the bot
// is told). contract.mjs's every member is in one list or the other: a test keeps it so,
// so a new one cannot slip past.
export const CARRIES = ['openRoom', 'renameRoom', 'post', 'reply', 'postCard', 'editCard', 'postDialog', 'closeDialog', 'postFile', 'postFolded', 'tellOwner', 'showForm', 'showOverview', 'showRecord'];
export const CARRIES_NOTHING = ['ready', 'bytes', 'split', 'start', 'command', 'placeRoom', 'endRoom', 'reviveRoom', 'pin', 'unpin', 'pinned', 'markWorking', 'markDone', 'image', 'download'];

// The chat app, its carrying members hidden where they should be; what was hidden is logged
// by kind, never what it was.
export function redactingChat(chat, redact, log) {
  const wrapped = Object.create(chat);
  for (const name of CARRIES) {
    if (typeof chat[name] !== 'function') continue;
    wrapped[name] = (...args) => {
      const { value, hits } = redactValue(redact, args);
      if (hits.length) log(`hidden in ${name}: ${[...new Set(hits)].map((h) => `${h} ×${hits.filter((x) => x === h).length}`).join(', ')}`);
      return chat[name](...value);
    };
  }
  return wrapped;
}
