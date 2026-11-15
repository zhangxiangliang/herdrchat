// What Telegram is sent, as data: the core's markdown as Telegram's HTML parse mode shows
// it (core.telegram.org/bots/api, "Formatting options": only b, i, code, pre, a and
// blockquote are used; every other <, > and & is escaped), cut so each piece stays under
// the 4096 characters a message may hold after parsing; and the messages and buttons
// made of it. Nothing here calls Telegram; client.mjs does.
import * as words from '../../core/words.mjs';
import { blocksOf, dialogBody } from '../blocks.mjs';

const LIMIT = 3800; // room for the tags around a piece

export const escapeHtml = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// In a bot's chat, Telegram makes every "/word" a command you can tap, so a path
// (/tmp/a.txt, ~/notes) is sent as code: shown as it is, copied as it is. The bot's own
// commands stay tappable. `text` is escaped HTML with no tags yet.
const OWN = new Set([...words.COMMANDS.map((c) => `/${c.command}`), '/auth']);
export const unlinked = (text) => text.replace(/(^|[\s(["'=])(~?\/[\w.@+%-]+(?:\/[\w.@+%~-]*)*)/g, (all, before, path) => (OWN.has(path) ? all : `${before}<code>${path}</code>`));

// Inline marks on one line of plain text (not inside a code block): **bold**, _italic_
// and *italic*, `code`, [links](https://...). A mark the core escaped (\*) is the mark
// itself, so it is kept aside first and never read as one.
function inline(line) {
  const codes = [];
  const kept = [];
  let s = line.replace(/`([^`\n]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = s.replace(/\\([\\`*_[\]#>~|])/g, (_, c) => `\u0001${kept.push(c) - 1}\u0001`);
  s = unlinked(escapeHtml(s));
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, text, url) => `<a href="${url.replace(/"/g, '&quot;')}">${text}</a>`);
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  s = s.replace(/(^|[^\w*])_([^_\n]+)_(?=$|[^\w])/g, '$1<i>$2</i>');
  s = s.replace(/(^|[^\w*])\*(?!\s)([^*\n]*[^*\s])\*(?=$|[^\w*])/g, '$1<i>$2</i>');
  s = s.replace(/\u0001(\d+)\u0001/g, (_, i) => escapeHtml(kept[Number(i)]));
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

// A post's blocks (../blocks.mjs) as messages, each {html, plain} under the limit: text
// through toHtml (cut first, as its marks need); a screen as <pre>, plain words, and your
// words (bold who, then a quote), escaped here, cut on their lines. Then as few messages
// as they fit in, a blank line between blocks. A block `html` is this app's own, made by
// its split (below), sent as it is.
// An image block is no text: its ref is in `found`, the photos to send after the text
// (index.mjs). Text from before image blocks may still hold an image's old mark; it goes.
const OLD_IMAGE_MARK = /\u2063img\d+\u2063/g;
const unmarkedOld = (text) => String(text || '').replace(OLD_IMAGE_MARK, '').replace(/\n{3,}/g, '\n\n').trim();
export function messagesOf(body, limit = LIMIT) {
  const parts = [];
  const found = [];
  // `text` escaped and cut on its lines; the first piece led by `head`, each in open/close
  const lines = (text, { open = '', close = '', head = '', headPlain = '' } = {}) => {
    let held = [];
    let first = true;
    const flush = () => {
      if (!held.length) return;
      const shown = escapeHtml(held.join('\n'));
      parts.push({ html: `${first ? head : ''}${open}${open === '<pre>' ? shown : unlinked(shown)}${close}`, plain: `${first ? headPlain : ''}${held.join('\n')}` });
      held = [];
      first = false;
    };
    const room = limit - open.length - close.length - head.length;
    for (const line of String(text).split('\n')) {
      for (let rest = line; ; rest = rest.slice(room / 2)) {
        const piece = rest.slice(0, room / 2); // escaped, at most 5 times as long; cut so it fits
        if (escapeHtml([...held, piece].join('\n')).length > room) flush();
        held.push(piece);
        if (rest.length <= room / 2) break;
      }
    }
    flush();
  };
  for (const b of blocksOf(body)) {
    if (b.kind === 'screen') lines(b.text, { open: '<pre>', close: '</pre>' });
    else if (b.kind === 'plain') lines(b.text);
    else if (b.kind === 'you') {
      const who = b.from ? words.from(b.from) : `${words.YOU}:`;
      const to = b.answerTo ? ` (${words.answerTo(b.answerTo)})` : '';
      lines(b.text, { open: '<blockquote>', close: '</blockquote>', head: `<b>${escapeHtml(who)}</b>${to ? ` <i>${escapeHtml(to.trim())}</i>` : ''}\n`, headPlain: `${who}${to}\n` });
    } else if (b.kind === 'image') {
      found.push(b.ref);
      if (b.fromYou) parts.push({ html: `<b>${escapeHtml(words.YOU)}:</b>`, plain: `${words.YOU}:` });
    } else if (b.kind === 'html') {
      const html = unmarkedOld(b.html);
      if (html) parts.push({ html, plain: unmarkedOld(b.plain) });
    } else {
      const text = unmarkedOld(b.markdown);
      if (text) parts.push(...split(text, limit).map((piece) => ({ html: toHtml(piece), plain: piece })));
    }
  }
  const messages = [];
  for (const p of parts) {
    const last = messages[messages.length - 1];
    if (last && last.html.length + 2 + p.html.length <= limit) messages[messages.length - 1] = { html: `${last.html}\n\n${p.html}`, plain: `${last.plain}\n\n${p.plain}` };
    else messages.push(p);
  }
  return { messages, found };
}

// What a ring quotes of the message it answers, {text, entities}, or null: its first
// line with words, as Telegram shows it, so it is an exact part of the message
// (reply_parameters.quote must be one); at most QUOTE characters. A quote that holds bold
// or italic must say where (quote_entities), so the start of a line before its first such
// mark is taken first (not a bold title, not the italic footer); a message with no such
// line (an italic note alone) is quoted with its marks.
const QUOTE = 80;
const MARK = { b: 'bold', i: 'italic', u: 'underline', s: 'strikethrough' };
const unescaped = (text) => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const hasWords = (text) => /[\p{L}\p{N}]/u.test(text);
// a line of our HTML as Telegram's text and its bold/italic entities (offsets in UTF-16)
function lineOf(line) {
  let text = '';
  const entities = [];
  const open = {};
  for (const part of line.split(/(<[^>]*>)/)) {
    const tag = part.match(/^<(\/?)([a-z-]+)/);
    if (!tag) {
      text += unescaped(part);
      continue;
    }
    if (!MARK[tag[2]]) continue;
    if (!tag[1]) open[tag[2]] = text.length;
    else if (open[tag[2]] !== undefined) {
      entities.push({ type: MARK[tag[2]], offset: open[tag[2]], length: text.length - open[tag[2]] });
      delete open[tag[2]];
    }
  }
  return { text, entities };
}
function cutQuote({ text, entities }) {
  const lead = text.length - text.trimStart().length;
  let quote = text.trim();
  if (Array.from(quote).length > QUOTE) quote = Array.from(quote).slice(0, QUOTE).join('').trimEnd();
  const kept = entities
    .map((e) => ({ ...e, offset: e.offset - lead }))
    .map((e) => ({ ...e, length: Math.min(e.offset + e.length, quote.length) - Math.max(e.offset, 0), offset: Math.max(e.offset, 0) }))
    .filter((e) => e.length > 0);
  return { text: quote, entities: kept };
}
export function quoteOf(html) {
  const lines = String(html || '').split('\n');
  for (const line of lines) {
    const head = unescaped(line.split(/<(?:b|i|u|s|tg-spoiler)>/)[0].replace(/<[^>]*>/g, ''));
    if (hasWords(head)) return cutQuote({ text: head, entities: [] });
  }
  for (const line of lines) {
    if (/<tg-spoiler>/.test(line)) continue;
    const parsed = lineOf(line);
    if (hasWords(parsed.text)) return cutQuote(parsed);
  }
  return null;
}

// A post's footer (where it came from; the core's {app, model, ...}, said by
// words.footer): a last line in italics.
export const footHtml = (footer) => (words.footer(footer) ? `\n\n<i>${escapeHtml(words.footer(footer))}</i>` : '');
export const footPlain = (footer) => (words.footer(footer) ? `\n\n${words.footer(footer)}` : '');

export const cut = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

// A card (the core's look): its title in bold, its text, its footer.
// (look.body: blocks; a notice of the bot's own has markdown) -> {html, plain, found}
export function lookOf(look) {
  const { messages, found } = messagesOf(look.body ?? look.markdown);
  const join = (f) => messages.map((m) => m[f]).join('\n\n');
  return { html: `<b>${escapeHtml(look.title)}</b>\n\n${join('html')}${footHtml(look.footer)}`, plain: `${look.title}\n\n${join('plain')}${footPlain(look.footer)}`, found };
}
// How much a body is as this app sends it, and the body cut into ones that each fit a
// message (the core's live card: liveBytes, split).
export const bytesOf = (body) => messagesOf(body).messages.reduce((n, m, i) => n + m.html.length + (i ? 2 : 0), 0);
// Its images go with the last body (sent after that card).
export const splitBody = (body) => {
  const { messages, found } = messagesOf(body);
  const bodies = messages.length ? messages.map((m) => [{ kind: 'html', html: m.html, plain: m.plain }]) : [[]];
  bodies[bodies.length - 1].push(...found.map((ref) => ({ kind: 'image', ref })));
  return bodies;
};

// a dialog's body, whole (a dialog is one message): {html, plain}
export function dialogText(dialog) {
  const { messages } = messagesOf(dialogBody(dialog));
  return { html: messages.map((m) => m.html).join('\n\n'), plain: messages.map((m) => m.plain).join('\n\n') };
}
export const dialogHtml = (dialog) => `<b>${escapeHtml(dialog.title)}</b>\n\n${dialogText(dialog).html}${dialog.menu?.free ? `\n\n<i>${escapeHtml(words.orTypeHere(dialog.menu.free.label))}</i>` : ''}${footHtml(dialog.footer)}`;
export const doneHtml = (dialog, done) => `<b>${escapeHtml(dialog.doneTitle)}</b>\n\n${dialogText(dialog).html}\n\n<b>${escapeHtml(done)}</b>${footHtml(dialog.footer)}`;

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
  if (dialog.menu.multi) rows.push([{ text: words.NEXT_BUTTON, callback_data: `${id}:tab` }]);
  rows.push([{ text: words.ESC_BUTTON, callback_data: `${id}:esc` }]);
  return { inline_keyboard: rows };
}

// A card's own buttons ([{label}]) side by side; each carries "<id>:<index>".
export const buttonsKeyboard = (buttons, id) => ({ inline_keyboard: [buttons.map((b, i) => ({ text: cut(b.label, BUTTON_TEXT), callback_data: `${id}:${i}` }))] });

// An expandable quote: two or three lines shown, the rest on a tap. It cannot hold code
// blocks or another quote, so only inline marks show in it: a code block's lines go as
// code, a quote's as they are.
function flatHtml(markdown) {
  let fence = false;
  const out = [];
  for (const line of String(markdown).split('\n')) {
    if (/^\s*```/.test(line)) {
      fence = !fence;
      continue;
    }
    if (fence) out.push(line ? `<code>${escapeHtml(line)}</code>` : '');
    else out.push(inline(line.replace(/^> ?/, '')));
  }
  return out.join('\n');
}
export const foldedHtml = (title, markdown) => `<b>${escapeHtml(title)}</b>\n<blockquote expandable>${flatHtml(markdown)}</blockquote>`;

// The overview: every terminal, the ones that need you first; a name links to its topic
// once the bot's username is known.
const MARKS = { blocked: '⚠️', error: '🔴', working: '⌛️', done: '✅', idle: '❓' };
const RANK = { blocked: 0, error: 1, working: 2, done: 3, idle: 4 };
export function overviewHtml(rows, username) {
  const sorted = [...rows].sort((a, b) => (RANK[a.state] ?? 5) - (RANK[b.state] ?? 5) || a.name.localeCompare(b.name));
  const waiting = rows.filter((r) => r.state === 'blocked').length;
  const head = `<b>${waiting ? '⚠️ ' : ''}${escapeHtml(words.overviewTitle(waiting, rows.length))}</b>`;
  if (!sorted.length) return `${head}\n\n${escapeHtml(words.NO_TERMINALS)}`;
  const lines = sorted.map((r) => {
    const name = r.room && username ? `<a href="https://t.me/${username}/${r.room}">${escapeHtml(r.name)}</a>` : escapeHtml(r.name);
    const at = r.since ? ` · ${words.since(new Date(r.since).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }))}` : '';
    return `${MARKS[r.state] || '❓'} <b>${name}</b> · ${escapeHtml(words.stateWord(r))}${at} · <code>${escapeHtml(r.address)}</code>`;
  });
  return `${head}\n\n${lines.join('\n')}`;
}
