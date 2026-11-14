import assert from 'node:assert/strict';
import test from 'node:test';
import { overviewCard, overviewText } from '../lib/chats/feishu/overview.mjs';

test('the overview puts what waits for you first and links every group', () => {
  const rows = [
    { name: 'alpha / docs', address: 't1', state: 'done', room: 'oc_a' },
    { name: 'beta / 1', address: 'box/t2', state: 'blocked', kind: 'permission', room: 'oc_b' },
    { name: 'alpha / build', address: 't3', state: 'working' },
    { name: 'alpha / shell', address: 't4', program: 'zsh' },
  ];
  const lines = overviewText(rows).split('\n');
  assert.match(lines[0], /^<text_tag color='orange'>needs you \(permission\)<\/text_tag> \*\*\[beta \/ 1\]\(https:\/\/applink\.feishu\.cn\/client\/chat\/open\?openChatId=oc_b\)\*\* · `box\/t2`$/);
  assert.match(lines[1], /^<text_tag color='blue'>working<\/text_tag> \*\*alpha \/ build\*\* · `t3`$/);
  assert.match(lines[2], /^<text_tag color='green'>done/);
  assert.match(lines[3], /^<text_tag color='neutral'>zsh<\/text_tag> \*\*alpha \/ shell\*\* · `t4`$/);
  const card = overviewCard(rows, Date.UTC(2026, 0, 1));
  assert.equal(card.header.template, 'orange');
  assert.equal(card.header.title.content, '1 needs you · herdrchat · 4 terminals');
  assert.equal(card.header.icon.token, 'warning_outlined', 'an icon says what it is, not an emoji');
});

test('marks in a name are entities, which Feishu reads in link text; a tag shows its words as they are', () => {
  const lines = overviewText([
    { name: 'worker / T1_ABC-2', address: 't6j', state: 'done', room: 'oc_a' },
    { name: 'a*b', address: 't7', program: 'my_prog <x>' },
  ]).split('\n');
  assert.ok(lines[0].includes('[worker / T1&#95;ABC-2]('), lines[0]);
  assert.ok(!lines.join('\n').includes('\\'), 'no backslash: Feishu shows it in link text and in tags');
  assert.ok(lines[1].startsWith("<text_tag color='neutral'>my_prog x</text_tag> **a&#42;b**"), lines[1]);
});
