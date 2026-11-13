import assert from 'node:assert/strict';
import test from 'node:test';
import { menuOf } from '../lib/core/menu.mjs';

const RULE = '─'.repeat(60);

const permission = (cmd) => [
  '⏺ Running a command.',
  RULE,
  ' Bash command',
  ` ${cmd}`,
  '╌'.repeat(60),
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  '   2. Yes, and always allow access to cardtest from this project',
  '   3. No',
  '',
  ' Esc to cancel · Tab to amend',
  '[hc] incomplete: older output may be missing',
].join('\n');

test('menuOf reads a permission dialog', () => {
  const m = menuOf(permission('touch a.txt'));
  assert.equal(m.text, 'Bash command\ntouch a.txt\nDo you want to proceed?');
  assert.deepEqual(m.options.map((o) => `${o.n} ${o.label}`), ['1 Yes', '2 Yes, and always allow access to cardtest from this project', '3 No']);
  assert.equal(m.multi, false);
  assert.equal(m.free, null);
});

test('two dialogs that look alike have different keys', () => {
  assert.notEqual(menuOf(permission('touch a.txt')).key, menuOf(permission('rm -rf build')).key);
  assert.equal(menuOf(permission('touch a.txt')).key, menuOf(permission('touch a.txt')).key);
});

const colors = (red, blue, cursor = 1) => [
  'Steps:',
  '1. Plan the work',
  '2. Do it',
  RULE,
  '←  ☐ Colors  ☐ Size  ✔ Submit  →',
  '',
  'Pick colors',
  '',
  `${cursor === 1 ? '❯' : ' '} 1. [${red ? '✔' : ' '}] Red`,
  '         Red',
  '  2. [ ] Green',
  `  3. [${blue ? '✔' : ' '}] Blue`,
  '  4. [ ] Type something',
  '     Next',
  RULE,
  '  5. Chat about this',
  '',
  'Enter to select · Tab/Arrow keys to navigate · Esc to cancel',
].join('\n');

test('menuOf reads a multi-select: the last numbered run, check marks, the free option', () => {
  const m = menuOf(colors(true, false));
  assert.equal(m.text, '←  ☐ Colors  ☐ Size  ✔ Submit  →\nPick colors');
  assert.deepEqual(m.options.map((o) => o.label), ['Red', 'Green', 'Blue', 'Type something', 'Chat about this']);
  assert.deepEqual(m.options.map((o) => o.checked), [true, false, false, false, null]);
  assert.equal(m.multi, true);
  assert.equal(m.free.n, 4);
});

test('a toggled box or a moved cursor keeps the dialog key', () => {
  assert.equal(menuOf(colors(false, false)).key, menuOf(colors(true, true, 3)).key);
});

test('menuOf: no numbered menu, no dialog', () => {
  assert.equal(menuOf('Login required. Open the link below.\n> '), null);
  assert.equal(menuOf('2. a\n3. b'), null);
});

test('a multi-question dialog keeps its key as its question tabs get their marks', async () => {
  const { menuOf } = await import('../lib/core/menu.mjs');
  const draw = (tabs, mark) => ['──────────────────────', ` ← ${tabs} →`, '', 'Which sizes?', '', `❯ 1. [${mark}] Small`, '  2. [ ] Large', '  3. Type something.'].join('\n');
  const before = menuOf(draw('☐ Colors  ☐ Sizes  ✔ Submit', ' '));
  const after = menuOf(draw('☒ Colors  ☐ Sizes  ✔ Submit', '✔'));
  assert.equal(before.key, after.key);
  assert.equal(after.options[0].checked, true);
  assert.notEqual(before.key, menuOf(draw('☐ Colors  ☐ Sizes  ✔ Submit', ' ').replace('Which sizes?', 'Which colors?')).key, 'another question is another dialog');
});
