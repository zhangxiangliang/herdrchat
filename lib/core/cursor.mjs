// What was already posted from an agent's conversation log (a .jsonl file), so a reader
// returns only what is new. Shared by every reader that reads such a log.
//
// A cursor is {at, seen}: `seen` lists [id, at] of every item posted in the last LAG_MS,
// and `at` trails the newest posted item by LAG_MS. An item counts as new when it is
// after `at` and not seen, so an entry written late with an older timestamp (within
// LAG_MS) is still picked up, and nothing is posted twice.
import crypto from 'node:crypto';

export const LAG_MS = 10 * 60 * 1000;

export function startCursor(at) {
  return { at, seen: [] };
}

function after(cursor, at, id) {
  return at > cursor.at && !cursor.seen.some(([seenId]) => seenId === id);
}

function idOf(entry) {
  if (entry.uuid) return entry.uuid;
  return crypto.createHash('sha1').update(`${entry.type}|${entry.timestamp}|${entry.operation || ''}|${entry.content || ''}`).digest('hex');
}

// The items after `cursor` in log `lines`, in order, using `entryItems(entry)` (the
// reader's own parser) for the items one entry holds. Each item gets the entry's
// timestamp (`at`) and a stable `id`. `complete` says whether `lines` reach back far
// enough: when the oldest readable entry is already after the cursor, older unposted
// entries may lie outside these lines, so the caller must read the whole file.
export function itemsAfter(lines, cursor, entryItems) {
  const found = [];
  let oldest = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // a cut first line or a half-written last line
    }
    if (!entry.timestamp) continue;
    if (oldest === null || entry.timestamp < oldest) oldest = entry.timestamp;
    const id = idOf(entry);
    if (!after(cursor, entry.timestamp, id)) continue;
    entryItems(entry).forEach((it, i) => found.push({ ...it, at: entry.timestamp, id: i ? `${id}#${i}` : id }));
  }
  return { items: found, complete: oldest !== null && oldest <= cursor.at };
}

// The cursor once `items` are posted.
export function advance(cursor, items) {
  const seen = [...cursor.seen, ...items.map((it) => [it.id, it.at])];
  const newest = seen.reduce((max, [, at]) => (at > max ? at : max), cursor.at);
  const lagged = new Date(new Date(newest).getTime() - LAG_MS).toISOString();
  const at = lagged > cursor.at ? lagged : cursor.at;
  return { at, seen: seen.filter(([, t]) => t > at) };
}
