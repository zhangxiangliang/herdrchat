// The menu a blocked program shows on its screen, as Claude Code draws its permission
// and question dialogs:
//   ❯ 1. Yes                      a digit key picks an option
//     2. [✔] Red                  in a multi-select, a digit toggles it; tab goes on
//     3. Type something.          picking it lets you type your own answer
// The last run of options numbered 1, 2, 3, ... on the screen is the menu; lines between
// them (an option's description) are skipped. null when there is none.
//
// `text` is what the dialog says above its options: from its top border (a line of ─),
// without rules and blank lines; what was on the screen above the dialog is left out.
// `key` names the dialog: a hash of it from its top border to its last option, without
// the cursor and any check mark (an option's [✔], and the ☐/☒/✔ of the question tabs
// above a multi-question dialog, which change as you answer: the same dialog keeps its key). A card click is pressed only when the
// screen still shows the dialog with that key, so an old card can never answer a newer
// dialog that looks alike (two permission prompts both offer "1. Yes").
//
// A question with previews draws a box beside its options, on the same lines, and the
// box shows the preview of the option under the cursor: what is right of it is cut off
// (three spaces or more, then a box line), so it is neither part of an option's label
// nor of the key; a question's own left border (│) goes too.
import crypto from 'node:crypto';

const OPTION = /^\s*(?:❯\s*)?(\d{1,2})\.\s+(?:\[(.)\]\s+)?(.*\S)\s*$/;
const RULE = /^[\s─╌━-]*$/;
const BORDER = /^\s*─{10,}/;
const FREE = /^Type something/i;
const BESIDE = /\s{3,}[┌└│├┤┐┘╭╰─┬┴┼║╔╚].*$/u;
const LEFT_BORDER = /^(\s*)│\s?/u;

const ownPart = (line) => line.replace(BESIDE, '').replace(LEFT_BORDER, '$1');

const TEXT_LINES = 15; // a dialog with no border found: this many lines above its options

function topOf(lines, first) {
  let top = first;
  while (top > 0 && !BORDER.test(lines[top])) top -= 1;
  return BORDER.test(lines[top]) ? top : Math.max(0, first - TEXT_LINES);
}

const MARKS = /[☐☑☒✔✓✗✘■□●○◉◯]/gu;

// Joined with spaces, not line breaks: the same dialog wraps at other places when the
// terminal is resized (herdr-app opened on a phone), and it is still the same dialog.
function keyOf(lines, top, last) {
  const body = lines.slice(top, last + 1).map((l) => l.replace(/❯/g, '').replace(/^(\s*\d{1,2}\.\s+)\[.\]/, '$1').replace(MARKS, '')).join(' ').replace(/\s+/g, ' ').trim();
  return crypto.createHash('sha1').update(body).digest('hex').slice(0, 12);
}

export function menuOf(screen) {
  const raw = screen.split('\n');
  const lines = raw.map(ownPart);
  let run = null;
  let menu = null;
  lines.forEach((line, i) => {
    const m = line.match(OPTION);
    if (!m) return;
    const n = Number(m[1]);
    if (n === 1) run = { first: i, options: [] };
    else if (!run || n !== run.options.length + 1) {
      run = null;
      return;
    }
    run.options.push({ n, label: m[3], checked: m[2] === undefined ? null : m[2] !== ' ' });
    run.last = i;
    menu = run;
  });
  if (!menu) return null;
  const top = topOf(lines, menu.first);
  // A question with previews takes no digit (its keys say "↑/↓ to navigate"): an option
  // is reached from the cursor (❯) with the arrows, then Enter.
  const beside = raw.slice(menu.first, menu.last + 1).some((l) => BESIDE.test(l));
  const cursor = menu.options.find((o, i) => raw.slice(menu.first, menu.last + 1).some((l) => /❯/.test(l) && new RegExp(`^\\s*❯\\s*${o.n}\\.`).test(l)))?.n || 1;
  return {
    beside,
    cursor,
    key: keyOf(lines, top, menu.last),
    framed: BORDER.test(lines[top]), // a dialog's top border; a numbered list in text has none
    text: lines.slice(top, menu.first).filter((l) => !RULE.test(l)).map((l) => l.trim()).join('\n'),
    options: menu.options,
    multi: menu.options.some((o) => o.checked !== null),
    free: menu.options.find((o) => FREE.test(o.label)) || null,
  };
}
