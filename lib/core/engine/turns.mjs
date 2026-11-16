// The core's posts of what a terminal says: its reader's items since the cursor, live
// while it works (one card edited in place), the turn's last answer as a new message, a
// post's footer, and the screen when there is nothing else to show.
import { advance, startCursor } from '../cursor.mjs';
import { machineOf, newOnScreen, tidyScreen } from '../hc.mjs';
import { branchOf } from '../meter.mjs';
import * as words from '../words.mjs';
import { SCREEN_LINES, TURN_SCREEN_LINES, END_TRIES, END_WAIT_MS, POST_TRIES, UPLOAD_TRIES } from './limits.mjs';
import { late } from './late.mjs';

export function createTurns(ctx) {
  const { agentOf, chat, deliver, endRoom, ensureRoom, hc, key, later, log, logError, logWarn, postTo, read, readerFor, ring, settleNote, shell, sleep, startedAt, views, write } = ctx;
  const { closeCard, markDone } = late(ctx, ['closeCard', 'markDone']);

  // Under each post: where it came from, as herdrchat knows it (never as the agent says):
  // the harness hc names, the model its own records name (or "screen" when it was read off
  // the screen), the git branch of the folder it runs in, how full its context is, and the
  // account's limits (lib/core/meter.mjs). What is not known is left out.
  const META = ['model', 'provider', 'context', 'limits'];
  // what the newest items say, over what the cursor kept
  function metaOf(items, cursor) {
    const meta = { ...(cursor.meta || (cursor.model ? { model: cursor.model } : {})) };
    for (const it of items) for (const f of META) if (it[f] !== undefined) meta[f] = it[f];
    return meta;
  }
  const BRANCH_MS = 15 * 1000;
  const branches = new Map(); // key -> {branch, at}
  async function branchNow(session, record) {
    const k = key(session, record.address);
    const was = branches.get(k);
    if (was && Date.now() - was.at < BRANCH_MS) return was.branch;
    const branch = await branchOf((script) => shell(session, machineOf(record.address), script), record.foreground?.cwd || record.cwd).catch(() => '');
    branches.set(k, { branch, at: Date.now() });
    return branch;
  }
  async function footerFor(session, record, app, meta = {}, { screen = false } = {}) {
    const reader = readerFor(app);
    const [branch, more] = await Promise.all([branchNow(session, record), reader?.meter ? Promise.resolve(reader.meter(session, record.address, meta)).catch(() => ({})) : {}]);
    const context = meta.context ? { used: meta.context.used, size: meta.context.size || more?.contextSize } : undefined;
    return { app: reader?.short || app, model: meta.model, screen, branch, context, limits: meta.limits || more?.limits };
  }
  const screenFooter = (session, record) => footerFor(session, record, record.status?.app || record.foreground?.name, {}, { screen: true });
  const agentFooter = (session, record, reader) => footerFor(session, record, reader.app, metaOf([], cursorOf(key(session, record.address))));

  // A terminal's screen, as a block of a post (lib/chats/blocks.mjs): the chat app shows it
  // as it is.
  async function screen(session, address, lines = SCREEN_LINES) {
    return { kind: 'screen', text: tidyScreen(await hc.screenTail(session, address, lines)) || words.BLANK };
  }
  // What came on the screen since `before` (a long screen folds in the chat, and the top it
  // shows would be old); its tail when the two cannot be lined up.
  async function screenSince(session, address, before) {
    const now = tidyScreen(await hc.screenTail(session, address, TURN_SCREEN_LINES));
    return { kind: 'screen', text: newOnScreen(before, now) ?? (tidyScreen(now, SCREEN_LINES) || words.BLANK) };
  }

  // Per terminal, in state.json: the cursor of what its reader posted, which reader and
  // which log that was (kept after the program exits, to post what it left).
  const cursorOf = (k) => read().cursors?.[k] || { ...startCursor(startedAt), reader: null, file: null };
  function saveCursor(k, cursor) {
    const state = read();
    state.cursors = { ...(state.cursors || {}), [k]: cursor };
    write(state);
  }

  // What you sent from the chat; its room shows it already, so it is not posted again.
  const fromChat = new Map();
  // Terminals you sent a message to that nothing of their records has shown since: a turn
  // that ends so posts the screen instead of nothing (an agent can take a message as its
  // own command and keep no record of it: Claude Code's "Unknown command: /update"). Each
  // keeps its screen from just before the message went in, so only what came after is posted.
  // One that never even starts working (Codex: "Unrecognized command", your words left in
  // its input box) has no turn to end: its screen is posted once START_WAIT_MS has passed.
  const unanswered = new Map(); // terminal key -> {screen, sent, started}
  async function notStarted(session, address, entry) {
    const k = key(session, address);
    if (unanswered.get(k) !== entry || entry.started) return;
    const state = (await hc.getTerminal(session, address).catch(() => null))?.status?.state;
    if (['working', 'blocked'].includes(state)) return; // busy with what it had: it gets to yours
    const record = views.get(session)?.terminals.get(address);
    if (!record || record.state !== 'live') return;
    unanswered.delete(k);
    logWarn(`${session}/${address}: did not start working on your message; posting the screen`);
    const shown = await screenSince(session, address, entry.screen);
    // your words left in its input box would be put in front of what you send next
    const keys = agentOf(record)?.leftInput?.(shown.text, entry.sent);
    if (keys) await hc.keys(session, address, keys).catch((err) => logWarn(`${session}/${address}: input box not emptied (${err.message})`));
    const body = [shown, ...(keys ? [{ kind: 'text', markdown: words.INPUT_EMPTIED }] : [])];
    await ring(k, await postTo(session, record, body, await screenFooter(session, record)), 'needs', body);
    await markDone(k);
  }

  // A message another terminal sent with `hc send` reaches the agent wrapped by hc as
  // <hc from="t7 review" reach="...">...</hc> (any agent: hc adds it), so it is shown as
  // from that terminal, not as yours; what is around such notes is yours.
  const HC_NOTE = /<hc from="([^"]*)"(?:\s+reach="([^"]*)")?>([\s\S]*?)<\/hc>/g;
  // What this bot sends is yours, but hc tags a send from a process outside any terminal
  // to a terminal on another machine as from that process ("m1/ppid:68564": the bot,
  // hc's parent). The bot's own process ids (engine.mjs keeps them, over restarts) tell
  // such a note from one another program sent.
  const PPID = /(?:^|\/)ppid:(\d+)$/;
  const ours = (from) => {
    const pid = from.match(PPID)?.[1];
    return Boolean(pid && (read().botPids || []).includes(Number(pid)));
  };
  // [{text, from?, answerTo?}]: your own words first, then each note (from: who sent it)
  function saidBy(text) {
    const notes = [];
    let rest = text;
    for (const m of text.matchAll(HC_NOTE)) {
      if (ours(m[1])) continue; // yours: stays in `rest`, its tag taken off below
      notes.push({ text: m[3].trim(), from: m[1], ...(m[2] ? { answerTo: m[2] } : {}) });
      rest = rest.replace(m[0], '');
    }
    rest = untagged(rest).trim();
    return rest ? [{ text: rest }, ...notes] : notes;
  }
  // your words, without the tag hc put on what this bot sent
  const untagged = (text) => text.replace(HC_NOTE, (all, from, reach, inner) => (ours(from) ? inner.trim() : all));
  // as blocks of a post (lib/chats/blocks.mjs): the chat app quotes and escapes them
  const youBlocks = (text) => saidBy(text).map((s) => ({ kind: 'you', ...s }));
  // in markdown, for the conversation's file (rooms.mjs: a document, not a post)
  const quoted = (text) => text.split('\n').map((l) => `> ${l}`).join('\n');
  const youOrOthers = (text, at = '') => saidBy(text).map((s) => (s.from
    ? `**${words.from(s.from)}**${at}${s.answerTo ? ` _(${words.answerTo(s.answerTo)})_` : ''}\n${quoted(s.text)}`
    : `**${words.YOU}:**${at ? ` ${at.replace(/^ · /, '')}` : ''}\n${quoted(s.text)}`)).join('\n\n');

  // Items as a post's blocks (lib/chats/blocks.mjs); what you sent from the chat is left out.
  // The tools it called, one after another, are one plain block, a line each: a command
  // or a path holds marks (* _ /) that are no markdown.
  const textBlock = (markdown) => ({ kind: 'text', markdown });
  function formatItems(k, items) {
    const sent = fromChat.get(k) || [];
    const parts = [];
    let tools = null;
    for (const it of items) {
      if (it.role === 'tool') {
        if (tools) tools.text = `${tools.text}\n${it.text}`;
        else parts.push((tools = { kind: 'plain', text: it.text }));
        continue;
      }
      tools = null;
      if (it.role === 'image') {
        // uploaded by uploadImages (its ref is the chat app's). One you send from the room
        // reaches the terminal as a file path, so it comes back as your text, not as an image.
        const fromYou = it.from === 'you' ? { fromYou: true } : {};
        if (it.key) parts.push({ kind: 'image', ref: it.key, ...fromYou });
        else parts.push(textBlock(`${it.from === 'you' ? `**${words.YOU}:**\n` : ''}_(${words.imageNotSent(it.from === 'you', it.error)})_`));
        continue;
      }
      if (it.role === 'you') {
        const i = sent.indexOf(untagged(it.text).trim());
        if (i >= 0) {
          sent.splice(i, 1);
          continue;
        }
        parts.push(...youBlocks(it.text));
      } else {
        parts.push(textBlock(it.text));
      }
    }
    return parts;
  }

  // While it works, a turn has one live card: a single message, edited in place as the
  // agent goes on, so the room shows it is alive without a new message (and a ringing
  // phone) every few seconds. The turn's last answer then comes as a new message. A full
  // card is closed and the next one goes on; a card that cannot be edited is sent again
  // as a new one (a repeat, never a loss). It is kept in the cursor (`live: {message,
  // body}`; one from before blocks has `text`), so a restart goes on editing it. How much
  // a card holds is the chat app's to say: it measures a body (bytes) and cuts it (split).
  const bodyOf = (live) => live.body || (live.text ? [textBlock(live.text)] : []);
  async function newLive(session, record, body, footer) {
    const parts = chat.split(body);
    let message = null;
    for (const [i, part] of parts.entries()) {
      const last = i === parts.length - 1;
      message = await deliver(session, record, (room) => chat.postCard(room, { title: last ? words.LIVE : words.FULL, tone: last ? 'working' : 'closed', body: part, footer }));
    }
    return message ? { message, body: parts[parts.length - 1], footer } : null;
  }

  async function addLive(session, record, live, add, footer) {
    if (!live) return newLive(session, record, add, footer);
    const body = [...bodyOf(live), ...add];
    if (chat.bytes(body) > chat.liveBytes) {
      await closeLive(live, words.FULL);
      return newLive(session, record, add, footer);
    }
    try {
      await chat.editCard(live.message, { title: words.LIVE, tone: 'working', body, footer });
      return { message: live.message, body, footer };
    } catch (err) {
      // it did not get through (the network): the card is kept, and what is added goes in
      // with the next edit; only a card the app will not edit is sent again
      if (err.unreached) {
        logWarn(`live card ${live.message} not edited (${err.message}); it is, with what comes next`);
        return { message: live.message, body, footer };
      }
      logError(`live card ${live.message} not editable (${err.message}); sending it again`);
      return newLive(session, record, body, footer);
    }
  }

  // An edit that did not get through is tried again a few times, so the card never stays
  // "working" for a dropped connection.
  async function closeLive(live, title = words.CLOSED) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await chat.editCard(live.message, { title, tone: 'closed', body: bodyOf(live), footer: live.footer });
        return;
      } catch (err) {
        if (err.unreached && attempt < POST_TRIES) {
          logWarn(`live card ${live.message} not closed (${err.message}); retry ${attempt}/${POST_TRIES - 1}`);
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        logError(`live card ${live.message} not closed (${err.message})`); // its text is all there
        return;
      }
    }
  }

  // Images go to the chat first: each once (by item id), so a post retried after a
  // failure does not upload it again. After UPLOAD_TRIES posts that failed on the same
  // image, the room gets a line saying it was not sent and why, so one image cannot hold
  // back everything after it.
  const uploaded = new Map();
  const uploadFailures = new Map();
  async function uploadImages(items) {
    for (const it of items) {
      if (it.role !== 'image' || it.key || it.error) continue;
      if (!uploaded.has(it.id)) {
        try {
          uploaded.set(it.id, await chat.image(Buffer.from(it.data, 'base64')));
        } catch (err) {
          const failures = (uploadFailures.get(it.id) || 0) + 1;
          uploadFailures.set(it.id, failures);
          if (failures < UPLOAD_TRIES) throw err;
          it.error = err.message;
          logError(`image ${it.id} not sent after ${failures} tries: ${err.message}`);
          continue;
        }
        if (uploaded.size > 500) uploaded.delete(uploaded.keys().next().value);
      }
      it.key = uploaded.get(it.id);
    }
  }

  // `live`: a post while it works. Everything goes into the live card, except the turn's
  // last answer, which is left for the turn's end (not consumed, so nothing is lost).
  // Otherwise: what came before the last answer goes into the live card, which is closed,
  // and the answer onward is a new message; with no live card, everything is one message.
  // `asking`: it stopped to ask you, so that message rings no "done" (the question's card
  // rings you next).
  async function postItems(session, record, k, cursor, items, reader, file, { live = false, asking = false } = {}) {
    const answerAt = items.findIndex((it) => it.end);
    const take = live && answerAt >= 0 ? items.slice(0, answerAt) : items;
    if (!take.length && !(cursor.live && !live)) return;
    await uploadImages(take);
    // the newest model named so far; an item that only names it (role "model") is not shown
    // what the items say for the footer; an item that only says that (role "meta") is not shown
    const meta = metaOf(take, cursor);
    const footer = await footerFor(session, record, reader.app, meta);
    const shown = take.filter((it) => it.role !== 'meta');
    if (shown.length) unanswered.delete(k);
    let open = cursor.live || null;
    const shownAt = shown.findIndex((it) => it.end);
    const head = live ? shown : shownAt >= 0 ? shown.slice(0, shownAt) : open ? shown : [];
    const tail = live ? [] : shown.slice(head.length);
    const headBlocks = formatItems(k, head);
    if (headBlocks.length) open = await addLive(session, record, open, headBlocks, footer);
    if (!live && open) {
      await closeLive({ ...open, footer }); // the model may be named only now
      open = null;
    }
    const tailBlocks = formatItems(k, tail);
    if (tailBlocks.length) {
      const sent = await postTo(session, record, tailBlocks, footer);
      if (!asking) await ring(k, sent, 'done', tailBlocks);
    }
    const last = shown[shown.length - 1];
    saveCursor(k, { ...advance(cursor, take), reader: reader.app, file, meta, ended: last ? last.role === 'ai' && Boolean(last.end) : cursor.ended, live: open });
    if (take.length) log(`<- ${session}/${record.address}: ${take.length} items (${reader.app}${live ? ', live card' : ''})`);
  }

  // Posts what a terminal said since the last post, through its reader. With
  // `waitForEnd`, it first waits for the turn's last answer (hc reports the end before
  // the agent writes it). Returns false when the terminal is not readable.
  async function postRead(session, address, record, reader, { waitForEnd, live = false, asking = false }) {
    const k = key(session, address);
    const cursor = cursorOf(k);
    let found = null;
    for (let attempt = 0; attempt < (waitForEnd ? END_TRIES : 1); attempt += 1) {
      found = await reader.after(session, address, cursor);
      if (!found || found.items.some((it) => it.end)) break;
      if (!found.items.length && cursor.ended) break; // the live posts already reached the turn's end
      await sleep(END_WAIT_MS);
    }
    if (!found) return false;
    await postItems(session, record, k, cursor, found.items, reader, found.file, { live, asking });
    return true;
  }

  // `asked`: the message waiting for an answer when the turn ended (unanswered's entry
  // then). Only that one, still unanswered, gets the screen; one sent since is the next turn's.
  async function postTurn(session, address, record, asked) {
    const k = key(session, address);
    const reader = readerFor(record.status?.app);
    if (reader) {
      try {
        if (await postRead(session, address, record, reader, { waitForEnd: true })) {
          if (!asked || unanswered.get(k) !== asked) return;
          logWarn(`${session}/${address}: the turn ended with nothing in its ${reader.app} records since your message; posting the screen`);
        }
      } catch (err) {
        // on another machine a read that fails is that machine's link, for a moment: the
        // sweep posts what it said once it is back, and a screen now would come twice
        if (machineOf(address)) {
          logWarn(`${session}/${address}: ${reader.app} not readable (${err.message}); the sweep posts it once its machine answers`);
          return;
        }
        logError(`${session}/${address}: ${reader.app} not readable (${err.message}); posting the screen`);
      }
    }
    const before = unanswered.get(k)?.screen;
    unanswered.delete(k);
    const body = [before === undefined ? await screen(session, address, TURN_SCREEN_LINES) : await screenSince(session, address, before)];
    await ring(k, await postTo(session, record, body, await screenFooter(session, record)), 'done', body);
    log(`<- ${session}/${address}: screen`);
  }

  // The program is gone: post what its log still holds, then say it ended.
  async function postEnd(session, address, record, reason) {
    const k = key(session, address);
    const cursor = cursorOf(k);
    const reader = readerFor(cursor.reader);
    if (reader && cursor.file) {
      try {
        await postItems(session, record, k, cursor, await reader.rest(session, address, cursor), reader, cursor.file);
      } catch (err) {
        logError(`${session}/${address}: last ${reader.app} entries not readable (${err.message})`);
      }
    }
    await postTo(session, record, `🔚 **${words.TERMINAL_ENDED}**${reason ? ` (${reason})` : ''}`);
    await closeCard(k, words.ENDED_DONE); // what it asked goes with it
    await settleNote(k, 'ended');
    await markDone(k);
    await endRoom(k);
    // a new terminal that came up in the same tab while this one still ran takes the room now
    const tab = read().chats[k]?.tab;
    const next = tab && [...(views.get(session)?.terminals.values() || [])].find((t) => t.state === 'live' && t.address !== address && t.labels?.['herdr.tab'] === tab);
    if (next) later(session, next.address, 'room', () => ensureRoom(session, next));
  }

  return { agentFooter, cursorOf, footerFor, fromChat, notStarted, postEnd, postRead, postTurn, screen, screenFooter, unanswered, youOrOthers };
}
