// What Telegram is sent, as data: the core's markdown as Telegram's HTML parse mode shows
// it (core.telegram.org/bots/api, "Formatting options": only b, i, code, pre, a and
// blockquote are used; every other <, > and & is escaped), cut so each piece stays under
// the 4096 characters a message may hold after parsing; and the messages and buttons
// made of it. Nothing here calls Telegram; client.mjs does.
const LIMIT = 3800; // room for the tags around a piece

export const escapeHtml = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Inline marks on one line of plain text (not inside a code block).
function inline(line) {
  const codes = [];
  let s = line.replace(/`([^`\n]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = escapeHtml(s);
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, text, url) => `<a href="${url.replace(/"/g, '&quot;')}">${text}</a>`);
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  s = s.replace(/(^|[^\w*])_([^_\n]+)_(?=$|[^\w])/g, '$1<i>$2</i>');
  s = s.replace(/\\([\\`*_[\]#>~|])/g, '$1'); // the core's escapes: the mark itself
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${escapeHtml(codes[Number(i)])}</code>`);
}

export function toHtml(markdown) {
  const out = [];
  let fence = null; // lines of the open code block
  let quote = null; // lines of the open > quote
  const endQuote = () => {
    if (quote) out.push(`<blockquote>${quote.join('\n')}</blockquote>`);
    quote = null;
  };
  for (const line of (markdown || '').split('\n')) {
    if (/^\s*```/.test(line)) {
      if (fence) {
        out.push(`<pre>${escapeHtml(fence.join('\n'))}</pre>`);
        fence = null;
      } else {
        endQuote();
        fence = [];
      }
      continue;
    }
    if (fence) {
      fence.push(line);
      continue;
    }
    const q = line.match(/^> ?(.*)$/);
    if (q) {
      (quote ||= []).push(inline(q[1]));
      continue;
    }
    endQuote();
    out.push(inline(line));
  }
  if (fence) out.push(`<pre>${escapeHtml(fence.join('\n'))}</pre>`);
  endQuote();
  return out.join('\n');
}

// Markdown cut on line boundaries into pieces of at most `limit` characters; a code
// block cut in two is closed and opened again, so each piece converts on its own.
export function split(markdown, limit = LIMIT) {
  const pieces = [];
  let current = [];
  let size = 0;
  let open = false;
  const flush = () => {
    if (!current.length) return;
    pieces.push(open ? [...current, '```'].join('\n') : current.join('\n'));
    current = open ? ['```'] : [];
    size = current.length ? 4 : 0;
  };
  for (const raw of (markdown || '').split('\n')) {
    for (let line = raw; ; ) {
      const piece = line.length > limit ? line.slice(0, limit) : line;
      if (size + piece.length + 1 > limit && current.length) flush();
      current.push(piece);
      size += piece.length + 1;
      if (/^\s*```/.test(piece)) open = !open;
      if (line.length <= limit) break;
      line = line.slice(limit);
    }
  }
  if (current.length) pieces.push(current.join('\n'));
  return pieces.length ? pieces : [''];
}

// A post's footer (where it came from): a last line in italics.
export const footHtml = (footer) => (footer ? `\n\n<i>${escapeHtml(footer)}</i>` : '');
export const footPlain = (footer) => (footer ? `\n\n${footer}` : '');

export const cut = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

// A card (the core's look): its title in bold, its text, its footer.
export const lookHtml = ({ title, markdown, footer }) => `<b>${escapeHtml(title)}</b>\n\n${toHtml(markdown)}${footHtml(footer)}`;

export const dialogHtml = (dialog) => `<b>${escapeHtml(dialog.title)}</b>\n\n${toHtml(dialog.markdown)}${dialog.menu?.free ? `\n\n<i>Or type your answer here (${escapeHtml(dialog.menu.free.label)}).</i>` : ''}${footHtml(dialog.footer)}`;
export const doneHtml = (dialog, done) => `<b>${escapeHtml(dialog.doneTitle)}</b>\n\n${toHtml(dialog.markdown)}\n\n<b>${escapeHtml(done)}</b>${footHtml(dialog.footer)}`;

// A dialog's buttons, one option a row; each carries "<id>:<pick>", id naming the dialog
// (index.mjs keeps what it stands for).
const BUTTON_TEXT = 60;
export function dialogKeyboard(dialog, id) {
  const rows = [];
  for (const o of dialog.menu.options) {
    if (o === dialog.menu.free) continue;
    const box = o.checked === null || o.checked === undefined ? '' : o.checked ? '☑ ' : '☐ ';
    rows.push([{ text: cut(`${o.n}. ${box}${o.label}`, BUTTON_TEXT), callback_data: `${id}:${o.n}` }]);
  }
  if (dialog.menu.multi) rows.push([{ text: 'Next ⇥', callback_data: `${id}:tab` }]);
  rows.push([{ text: 'Esc (cancel)', callback_data: `${id}:esc` }]);
  return { inline_keyboard: rows };
}

// A card's own buttons ([{label}]) side by side; each carries "<id>:<index>".
export const buttonsKeyboard = (buttons, id) => ({ inline_keyboard: [buttons.map((b, i) => ({ text: cut(b.label, BUTTON_TEXT), callback_data: `${id}:${i}` }))] });

// An expandable quote: two or three lines shown, the rest on a tap. A quote cannot hold
// code blocks or another quote, so the text goes in plain, escaped.
export const foldedHtml = (title, markdown) => `<b>${escapeHtml(title)}</b>\n<blockquote expandable>${escapeHtml(markdown)}</blockquote>`;

// The overview: every terminal, the ones that need you first; a name links to its topic
// once the bot's username is known.
const STATES = { blocked: '⚠️', error: '🔴', working: '⌛️', done: '✅', idle: '❓' };
const RANK = { blocked: 0, error: 1, working: 2, done: 3, idle: 4 };
export function overviewHtml(rows, username) {
  const sorted = [...rows].sort((a, b) => (RANK[a.state] ?? 5) - (RANK[b.state] ?? 5) || a.name.localeCompare(b.name));
  const waiting = rows.filter((r) => r.state === 'blocked').length;
  const head = `<b>${waiting ? `⚠️ ${waiting} needs you · ` : ''}herdrchat · ${rows.length} terminals</b>`;
  if (!sorted.length) return `${head}\n\nNo terminal is shown in herdr-app.`;
  const lines = sorted.map((r) => {
    const name = r.room && username ? `<a href="https://t.me/${username}/${r.room}">${escapeHtml(r.name)}</a>` : escapeHtml(r.name);
    const word = STATES[r.state] ? `${r.state === 'blocked' ? 'needs you' : r.state}${r.state === 'blocked' && r.kind ? ` (${r.kind})` : ''}` : r.program || 'no status';
    const at = r.since ? ` · since ${new Date(r.since).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` : '';
    return `${STATES[r.state] || '❓'} <b>${name}</b> · ${escapeHtml(word)}${at} · <code>${escapeHtml(r.address)}</code>`;
  });
  return `${head}\n\n${lines.join('\n')}`;
}
