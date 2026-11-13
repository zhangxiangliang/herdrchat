// The core's markdown, as Telegram's HTML parse mode shows it (core.telegram.org/bots/api,
// "Formatting options"): only b, i, code, pre, a and blockquote are used; every other
// <, > and & is escaped. Text is cut so each piece stays under the 4096 characters a
// message may hold after parsing.
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
