import assert from 'node:assert/strict';
import test from 'node:test';
import { LAG_MS, advance, itemsAfter, startCursor } from '../lib/cursor.mjs';

// A log of the simplest kind: one item per entry, with its text.
const at = (s) => new Date(Date.UTC(2026, 10, 12, 0, 0, s)).toISOString();
const line = (s, text, uuid) => JSON.stringify({ uuid, timestamp: at(s), text });
const parse = (e) => [{ role: 'ai', text: e.text }];
const after = (lines, cursor) => itemsAfter(lines, cursor, parse);

test('a cut or half-written line is skipped, and every item gets its own id', () => {
  const { items } = after(['{"cut', line(1, 'a', 'u1'), line(2, 'b', 'u2'), '{"half'], startCursor(at(0)));
  assert.deepEqual(items.map((x) => x.text), ['a', 'b']);
  assert.equal(new Set(items.map((x) => x.id)).size, 2);
});

test('two entries with the same timestamp: the one written later is not lost', () => {
  const first = [line(10, 'go', 'u1'), line(11, 'Part one.', 'a1')];
  let cursor = startCursor(at(0));
  cursor = advance(cursor, after(first, cursor).items);
  const later = [...first, line(11, 'Part two, same second.', 'a2')];
  assert.deepEqual(after(later, cursor).items.map((x) => x.text), ['Part two, same second.']);
});

test('an entry written late with an older timestamp is still posted, once', () => {
  let cursor = startCursor(at(0));
  const written = [line(10, 'go', 'u1'), line(30, 'Newer answer.', 'a2')];
  cursor = advance(cursor, after(written, cursor).items);
  const withLate = [...written, line(20, 'Older text, written last.', 'a1')];
  const r = after(withLate, cursor);
  assert.deepEqual(r.items.map((x) => x.text), ['Older text, written last.']);
  cursor = advance(cursor, r.items);
  assert.deepEqual(after(withLate, cursor).items, []);
});

test('a tail that does not reach back to the cursor asks for the whole file', () => {
  const cursor = startCursor(at(5));
  assert.equal(after([line(20, 'x', 'a1')], cursor).complete, false);
  assert.equal(after([line(5, 'old', 'u0'), line(20, 'x', 'a1')], cursor).complete, true);
});

test('the cursor forgets ids only once they are older than the lag', () => {
  const t0 = new Date(Date.UTC(2026, 10, 12)).getTime();
  const iso = (ms) => new Date(t0 + ms).toISOString();
  let cursor = startCursor(iso(0));
  cursor = advance(cursor, [{ id: 'old', at: iso(1000) }]);
  cursor = advance(cursor, [{ id: 'new', at: iso(1000 + LAG_MS + 5000) }]);
  assert.ok(cursor.seen.some(([id]) => id === 'new'));
  assert.ok(!cursor.seen.some(([id]) => id === 'old'));
  assert.equal(cursor.at, iso(6000));
});
