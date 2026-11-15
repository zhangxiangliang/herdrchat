// The core's rooms: one per herdr-app tab, named after where herdr-app shows it, kept
// when its terminal ends (marked ended), handed to the next terminal of its tab; what came
// before a new room (backfill); and posting into a terminal's room (deliver).
import { startCursor } from '../cursor.mjs';
import { splitWhere } from '../hc.mjs';
import * as words from '../words.mjs';
import { POST_TRIES, TITLE_MAX, WAIT, FILE_BYTES } from './limits.mjs';
import { late } from './late.mjs';

export function createRooms(ctx) {
  const { addressOfKey, agentOf, cfg, chat, handles, key, lanes, log, logError, logWarn, read, scopeOfKey, sleep, views, write } = ctx;
  const { cursorOf, youOrOthers } = late(ctx, ['cursorOf', 'youOrOthers']);

  const shownWhere = (record) => (record && record.state === 'live' ? splitWhere(record.labels?.where) : null);

  // A room is named after where herdr-app shows the terminal. A tab herdr-app only
  // numbered ("2") says nothing, so the terminal's title stands in for it (what Claude
  // Code sets as its session name or topic), then its hc name; leading status glyphs are
  // dropped, so a spinner in a title never renames a room.
  function tabName(where, record) {
    if (!/^\d+$/.test(where.tab)) return where.tab;
    // an agent whose title holds more than a name (Codex: "<thread> | <folder>") says which part
    const titled = agentOf(record)?.titleOf?.(record.title) ?? record.title;
    const title = String(titled || '').replace(/^[^\p{L}\p{N}]+/u, '').replace(/\s+/g, ' ').trim();
    const name = title || record.name || '';
    if (!name) return where.tab;
    return name.length > TITLE_MAX ? `${name.slice(0, TITLE_MAX - 1)}…` : name;
  }
  const roomName = (where, record) => `${where.space} / ${tabName(where, record)}`;

  function setRoom(k, fields) {
    const state = read();
    if (state.chats[k]) state.chats[k] = { ...state.chats[k], ...fields };
    write(state);
  }

  const roomOf = (session, address) => read().chats[key(session, address)];

  function terminalOfRoom(room) {
    for (const [k, v] of Object.entries(read().chats)) {
      if (v.chat === room) return { session: v.session, address: addressOfKey(k) };
    }
    return null;
  }

  // A room belongs to a herdr-app tab, by the tab's id (`herdr.tab`), not to the terminal
  // that happens to run in it: when the terminal is replaced (Claude quit and the tab got
  // a new shell, a program was started again), the new one takes over the tab's room once
  // the old one is gone. A tab that was deleted and made again has a new id, so a new
  // room. Returns the room, null (none: make one), or WAIT (the old terminal still runs:
  // its end hands the room over, see postEnd). The old terminal's last words go first.
  async function adoptTabRoom(k, tab) {
    const before = Object.entries(read().chats).find(([ok, c]) => ok !== k && c.tab === tab && scopeOfKey(ok) === scopeOfKey(k));
    if (!before) return null;
    const [ok, was] = before;
    if (views.get(was.session)?.terminals.get(addressOfKey(ok))?.state === 'live') return WAIT;
    await lanes.get(ok)?.catch(() => {}); // its end (postEnd) runs to the last item
    const state = read();
    const old = state.chats[ok];
    if (!old) return null;
    delete state.chats[ok];
    state.chats[k] = old;
    for (const map of [state.pinned, state.reacts]) {
      if (map?.[ok]) {
        map[k] = map[ok];
        delete map[ok];
      }
    }
    if (state.cursors) delete state.cursors[ok];
    write(state);
    log(`room ${old.name} (${old.chat}) now follows ${addressOfKey(k)}, the new terminal of its tab`);
    await chat.post(old.chat, words.newTerminalHere(addressOfKey(k))).catch((err) => logError(`adopt notice: ${err.message}`));
    return old;
  }

  async function ensureRoom(session, record) {
    const where = shownWhere(record);
    if (!where || !chat.ready() || !handles(session, record.address)) return null;
    const k = key(session, record.address);
    const name = roomName(where, record);
    const tab = record.labels?.['herdr.tab'] || null;
    // state.json is read again after each await: other lanes write it meanwhile
    const known = read().chats[k] || (tab ? await adoptTabRoom(k, tab) : null);
    if (known === WAIT) return null;
    if (known) {
      if (known.ended) await reviveRoom(k, known);
      if (known.name !== name || known.session !== session || (tab && known.tab !== tab)) {
        if (known.name !== name) await chat.renameRoom(known.chat, name);
        setRoom(k, { name, session, ...(tab ? { tab } : {}) });
        if (known.name !== name) log(`renamed room ${known.chat} -> ${name}`);
      }
      await chat.placeRoom(k, { space: where.space });
      return known.chat;
    }
    const room = await chat.openRoom({ name, intro: words.roomIntro(record.address, session) });
    const state = read();
    state.chats[k] = { chat: room, name, session, ...(tab ? { tab } : {}) };
    write(state);
    log(`created room ${name} (${room})`);
    await chat.placeRoom(k, { space: where.space });
    await backfill(session, record, k, room, name, cfg.history || { file: true, folded: true }).catch((err) => logError(`earlier conversation of ${record.address}:`, err));
    return room;
  }

  // A new room shows what came before it, so it does not open empty: the agent's whole
  // conversation so far as one file, and its newest part in one folded post, as much as
  // that holds. Only what lies before the room's cursor (the rest is posted the usual
  // way, so nothing comes twice); silent; only when a room is made, never on a restart.
  const clock = (at) => new Date(at).toISOString().replace('T', ' ').slice(0, 16);
  function transcriptOf(items) {
    const parts = [];
    for (const it of items) {
      if (it.role === 'you') parts.push(youOrOthers(it.text, ` · ${clock(it.at)}`));
      else if (it.role === 'ai') parts.push(it.text);
      else if (it.role === 'tool') parts.push(it.text);
      else if (it.role === 'image') parts.push(`_(${words.image(it.from === 'you')})_`);
    }
    return parts.join('\n\n');
  }

  // `parts`: which of {file, folded} to post (HERDR_HISTORY; /history posts both)
  async function backfill(session, record, k, room, name, parts = { file: true, folded: true }) {
    const reader = agentOf(record);
    if (!reader || (!parts.file && !parts.folded)) return;
    const until = cursorOf(k).at;
    const all = await reader.after(session, record.address, startCursor('0000-00-00T00:00:00.000Z'));
    const items = (all?.items || []).filter((it) => it.at <= until && it.role !== 'meta');
    if (!items.length) return;
    // a file both apps take (Feishu: 30 MB): the newest part when it is longer
    let whole = transcriptOf(items);
    if (Buffer.byteLength(whole) > FILE_BYTES) whole = `_(${words.oldestLeftOut(FILE_BYTES / 1e6)})_\n\n…${Buffer.from(whole).subarray(-FILE_BYTES).toString()}`;
    const day = clock(items[0].at).slice(0, 10);
    const file = `# ${name}\n\n${words.transcriptHead({ address: record.address, session, first: clock(items[0].at), last: clock(items[items.length - 1].at), count: items.length })}\n\n${whole}\n`;
    if (parts.file) await chat.postFile(room, { name: `${name.replace(/[^\p{L}\p{N}._-]+/gu, '-')}-${day}.md`, data: Buffer.from(file), caption: words.transcriptCaption(items.length) });
    // the newest items that fit, whole items only, oldest of them first
    const recent = [];
    let bytes = 0;
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const size = Buffer.byteLength(transcriptOf([items[i]])) + 2;
      if (bytes + size > chat.foldedBytes) break;
      recent.unshift(items[i]);
      bytes += size;
    }
    if (parts.folded && recent.length) await chat.postFolded(room, { title: words.beforeRoom(recent.length, items.length, parts.file), markdown: transcriptOf(recent) });
    log(`<- ${session}/${record.address}: earlier conversation, ${items.length} items (${recent.length} shown)`);
  }

  // A terminal that is gone keeps its room, with its history, marked ended, so a new
  // terminal in the same place gets a room that is not mistaken for the old one.
  async function endRoom(k, { again = false } = {}) {
    const known = read().chats[k];
    if (!known || (known.ended && !again)) return;
    setRoom(k, { ended: true });
    if (!again) log(`ended room ${known.name} (${known.chat})`);
    await chat.endRoom(k);
  }

  async function reviveRoom(k, known) {
    setRoom(k, { ended: false });
    await chat.reviveRoom(k);
    log(`room ${known.name} (${known.chat}) is live again`);
  }


  // ---------- posting ----------

  // A post is retried; when it still fails, the caller keeps its cursor, so the same
  // content goes out with the next post: a repeat is acceptable, a loss is not.
  // A terminal that has ended keeps the room it had (its last words and the ended notice go
  // there); only a live one gets a room made, renamed or revived.
  async function deliver(session, record, send) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        const room = record.state === 'live' ? await ensureRoom(session, record) : roomOf(session, record.address)?.chat || null;
        return room ? await send(room) : null;
      } catch (err) {
        if (attempt >= POST_TRIES) throw err;
        logWarn(`post to ${session}/${record.address} failed (${err.message}); retry ${attempt}/${POST_TRIES - 1}`);
        await sleep(1000 * 2 ** attempt);
      }
    }
  }
  // body: markdown, or blocks (lib/chats/blocks.mjs)
  const postTo = (session, record, body, footer) => deliver(session, record, (room) => chat.post(room, body, { footer }));

  return { backfill, deliver, endRoom, ensureRoom, postTo, roomName, roomOf, shownWhere, terminalOfRoom };
}
