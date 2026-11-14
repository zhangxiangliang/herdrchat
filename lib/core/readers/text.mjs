// Text helpers the readers share.

// One line of at most `max` characters, for a tool line.
export const short = (s, max = 120) => {
  const one = String(s || '').replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 3)}...` : one;
};

// The text of a message's content: a string as it is, or its text blocks (type "text", or
// Codex's "Text") joined by lines.
export const textOf = (content) => (typeof content === 'string' ? content : Array.isArray(content) ? content.filter((b) => /^text$/i.test(b?.type) && b.text).map((b) => b.text).join('\n') : '');
