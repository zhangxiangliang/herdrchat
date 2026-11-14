// What Feishu is sent and what it sends back, as data: the cards, and the parts of a
// message or a form. Nothing here calls Feishu; client.mjs does.
import * as words from '../../core/words.mjs';

const CHUNK = 6000;

// Splits on line boundaries; a code fence cut in two is closed and reopened.
export function chunk(text, size = CHUNK) {
  const parts = [];
  let current = [];
  let length = 0;
  let fence = null;
  const flush = () => {
    if (!current.length) return;
    let body = current.join('\n');
    if (fence !== null) body += '\n```';
    parts.push(body);
    current = fence !== null ? [fence] : [];
    length = current.length ? fence.length : 0;
  };
  for (const raw of text.split('\n')) {
    for (let line = raw; ; ) {
      const piece = line.length > size ? line.slice(0, size) : line;
      if (length + piece.length + 1 > size && current.length) flush();
      current.push(piece);
      length += piece.length + 1;
      if (/^\s*```/.test(piece)) fence = fence === null ? piece.trim() : null;
      if (line.length <= size) break;
      line = line.slice(size);
    }
  }
  if (current.length) {
    parts.push(current.join('\n'));
  }
  return parts.length ? parts : [''];
}

// What Feishu shows for a card in the chat list and in a reply's quote (the "done" ring
// quotes the post it rings on): its first line with words in it. Without it, Feishu takes
// the first text it finds, which for a screen (a code block first) is the footer. A label
// line ("You:") goes with the line after it.
const SUMMARY_CHARS = 80;
export function summaryOf(markdown) {
  const lines = String(markdown).split('\n')
    .map((l) => l.replace(/^\s*(```\S*|>|#+|[-*]\s)\s*/, '').replace(/\*\*|`/g, '').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).trim())
    .filter((l) => /[\p{L}\p{N}]/u.test(l));
  const line = /^[^:]{1,20}:$/.test(lines[0] || '') && lines[1] ? `${lines[0]} ${lines[1]}` : lines[0] || '';
  return line.length > SUMMARY_CHARS ? `${line.slice(0, SUMMARY_CHARS - 1)}…` : line;
}

// A markdown card for one chunk of a post, its footer under it.
export function markdownCard(markdown, footer) {
  const summary = summaryOf(markdown);
  return { schema: '2.0', ...(summary ? { config: { summary: { content: summary } } } : {}), body: { elements: [{ tag: 'markdown', content: markdown }, ...footerElements(footer)] } };
}

// Text shown as it is in a card's markdown: its marks as HTML entities, which Feishu reads
// everywhere in markdown (a backslash escape it shows inside link text).
export const entities = (text) => String(text).replace(/[\\`*_[\]#>~|<&]/g, (c) => `&#${c.charCodeAt(0)};`);

// A post's footer (where it came from; the core's {app, model, ...}, said by
// words.footer): one small grey line under it.
export function footerElements(footer) {
  const line = words.footer(footer);
  return line ? [{ tag: 'markdown', content: entities(line), text_size: 'notation' }] : [];
}

// A card's header: its title with Feishu's own icon for what the card is, in place of the
// emoji the core leads a title with (the icon says it once), and the color of its tone.
export const TONES = {
  working: { template: 'blue', icon: 'loading_outlined' },
  closed: { template: 'grey', icon: 'done_outlined' },
  needs: { template: 'orange', icon: 'warning_outlined' },
  done: { template: 'grey', icon: 'done_outlined' },
  good: { template: 'green', icon: 'done_outlined' },
  bad: { template: 'red', icon: 'warning_outlined' },
};
const LEADING_EMOJI = /^(?:[\p{Extended_Pictographic}\u2600-\u27BF][\uFE0F\u200D]*\s*)+/u;
export function header(title, tone) {
  const t = TONES[tone] || TONES.working;
  return { title: { tag: 'plain_text', content: String(title).replace(LEADING_EMOJI, '') || String(title) }, template: t.template, icon: { tag: 'standard_icon', token: t.icon, color: t.template } };
}

// A markdown card that can be edited after it is sent (updateCard needs update_multi
// on the card both before and after).
export function textCard(markdown, title, tone = 'working', footer = '') {
  return { schema: '2.0', config: { update_multi: true }, header: header(title, tone), body: { elements: [{ tag: 'markdown', content: markdown }, ...footerElements(footer)] } };
}

// A card that asks you to pick: the screen, one button per option and, when the program
// takes your own words, a box to type them. Every button and the box send a callback
// (card.action.trigger) whose value is `value` plus {pick: <option number>, label} (or
// {pick: 'tab'} / {pick: 'esc'}); the box's text comes back as form_value.answer.
const BUTTON_TEXT = 80;

function button(text, value, type = 'default') {
  const short = text.length > BUTTON_TEXT ? `${text.slice(0, BUTTON_TEXT - 1)}…` : text;
  return { tag: 'button', type, width: 'default', size: 'medium', text: { tag: 'plain_text', content: short }, hover_tips: { tag: 'plain_text', content: text }, behaviors: [{ type: 'callback', value }] };
}

// Buttons side by side, wrapping onto the next line when the screen is narrow.
const row = (buttons) => ({ tag: 'column_set', flex_mode: 'flow', horizontal_spacing: 'small', columns: buttons.map((b) => ({ tag: 'column', width: 'auto', elements: [b] })) });
// Short options (Yes / No) sit side by side; a long one would be cut there, so then each
// option is a line of its own, as wide as its words, at the left like the text above.
const SIDE_BY_SIDE = { most: 4, chars: 14 };
const fitsSideBySide = (labels) => labels.length <= SIDE_BY_SIDE.most && labels.every((l) => [...l].length <= SIDE_BY_SIDE.chars);
const options = (buttons, labels) => (fitsSideBySide(labels) ? [row(buttons)] : buttons);

// A multi-select's boxes are checkers in a form: with no behaviors a checker is ticked on
// the phone only, so ticking makes no call and shows no loading; Next submits the form,
// and each box comes back in form_value under its name, box_<n> (ticksOf reads them).
export const BOX = 'box_';
export function menuCard({ title, markdown, menu, value, footer = '' }) {
  const elements = [{ tag: 'markdown', content: markdown }];
  const boxes = [];
  const choices = [];
  for (const o of menu.options) {
    if (o === menu.free) continue;
    if (menu.multi && o.checked !== null) {
      boxes.push({ tag: 'checker', name: `${BOX}${o.n}`, checked: o.checked, text: { tag: 'plain_text', content: `${o.n}. ${o.label}` } });
      continue;
    }
    choices.push(button(`${o.n}. ${o.label}`, { ...value, pick: o.n, label: o.label }, o.n === 1 && !menu.multi ? 'primary_filled' : 'default'));
  }
  if (choices.length) elements.push(...options(choices, choices.map((b) => b.text.content)));
  if (menu.multi) {
    elements.push({ tag: 'form', name: 'boxes', elements: [...boxes, { ...button('Next ⇥', { ...value, pick: 'tab' }, 'primary_filled'), name: 'next', form_action_type: 'submit' }] });
  }
  if (menu.free) {
    elements.push({
      tag: 'form',
      name: 'free',
      elements: [
        { tag: 'input', name: 'answer', required: true, placeholder: { tag: 'plain_text', content: menu.free.label } },
        { ...button('Send', { ...value, pick: menu.free.n, label: menu.free.label }, 'primary_filled'), name: 'send', form_action_type: 'submit' },
      ],
    });
  }
  elements.push(row([button('Esc (cancel)', { ...value, pick: 'esc' }, 'danger_text')]), ...footerElements(footer));
  return { schema: '2.0', config: { update_multi: true }, header: header(title, 'needs'), body: { elements } };
}

// A card to the owner with buttons under its text (look.buttons: [{label, value}]): a tap
// sends the button's value, as a dialog's buttons do.
export function ownerCard({ title, tone, markdown, buttons = [] }) {
  const card = textCard(markdown, title, tone);
  if (buttons.length) card.body.elements.push(row(buttons.map((b, i) => button(b.label, b.value, i ? 'default' : 'primary_filled'))));
  return card;
}

// The card once it is answered: the same text, no buttons, and what was done.
// A dialog once answered (or gone): grey, its text, and what was done in small type.
export function doneCard(title, markdown, done, footer = '') {
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: header(title, 'done'),
    // the icon is the check: one the core leads `done` with goes
    body: { elements: [{ tag: 'markdown', content: markdown }, { tag: 'markdown', content: String(done).replace(/^[✔✓]\uFE0F?\s*/u, ''), text_size: 'notation', icon: { tag: 'standard_icon', token: 'done_outlined', color: 'grey' } }, ...footerElements(footer)] },
  };
}

// A card that shows its title and opens on a tap (card JSON 2.0 collapsible_panel).
export function foldedCard(title, markdown) {
  return {
    schema: '2.0',
    body: { elements: [{ tag: 'collapsible_panel', expanded: false, header: { title: { tag: 'markdown', content: `**${title}**` } }, border: { color: 'grey', corner_radius: '5px' }, elements: [{ tag: 'markdown', content: markdown }] }] },
  };
}

// What a received message says: its text and the keys of its images, in order, for
// text, image and rich text (post) messages; null for any other kind.
// null for what is not passed on: another type (a file, forwarded chat records, ...), or a
// content that is not JSON (a merged forward lists as "Merged and Forwarded Message").
export function messageParts(messageType, content) {
  let c;
  try {
    c = JSON.parse(content);
  } catch {
    return null;
  }
  if (!c || typeof c !== 'object') return null;
  if (messageType === 'text') return { text: c.text || '', images: [] };
  if (messageType === 'image') return { text: '', images: [c.image_key] };
  if (messageType !== 'post') return null;
  const lines = [];
  const images = [];
  if (c.title) lines.push(c.title);
  for (const paragraph of c.content || []) {
    let line = '';
    for (const el of paragraph) {
      if (el.tag === 'img' && el.image_key) images.push(el.image_key);
      else if (el.tag === 'a' && el.href) line += `${el.text || ''} (${el.href})`;
      else if (typeof el.text === 'string') line += el.text; // text, code_block, md, ...
    }
    lines.push(line);
  }
  return { text: lines.join('\n').trim(), images };
}

// The boxes as ticked, from a submitted form: {<n>: true|false}, or null when form_value
// has none of them (then nothing can be known, and nothing should be pressed). A checker's
// value is read as true when it is true or "true".
export function ticksOf(formValue) {
  const entries = Object.entries(formValue || {}).filter(([name]) => name.startsWith(BOX));
  if (!entries.length) return null;
  return Object.fromEntries(entries.map(([name, v]) => [Number(name.slice(BOX.length)), v === true || v === 'true']));
}
