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
// the cursor and the check marks. A card click is pressed only when the
// screen still shows the dialog with that key, so an old card can never answer a newer
// dialog that looks alike (two permission prompts both offer "1. Yes").
import crypto from 'node:crypto';

const OPTION = /^\s*(?:❯\s*)?(\d{1,2})\.\s+(?:\[(.)\]\s+)?(.*\S)\s*$/;
const RULE = /^[\s─╌━-]*$/;
const BORDER = /^\s*─{10,}/;
const FREE = /^Type something/i;

const TEXT_LINES = 15; // a dialog with no border found: this many lines above its options

function topOf(lines, first) {
  let top = first;
  while (top > 0 && !BORDER.test(lines[top])) top -= 1;
  return BORDER.test(lines[top]) ? top : Math.max(0, first - TEXT_LINES);
}

function keyOf(lines, top, last) {
  const body = lines.slice(top, last + 1).map((l) => l.replace(/❯/g, '').replace(/^(\s*\d{1,2}\.\s+)\[.\]/, '$1').trim()).join('\n');
  return crypto.createHash('sha1').update(body).digest('hex').slice(0, 12);
}

export function menuOf(screen) {
  const lines = screen.split('\n');
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
  return {
    key: keyOf(lines, top, menu.last),
    text: lines.slice(top, menu.first).filter((l) => !RULE.test(l)).map((l) => l.trim()).join('\n'),
    options: menu.options,
    multi: menu.options.some((o) => o.checked !== null),
    free: menu.options.find((o) => FREE.test(o.label)) || null,
  };
}
