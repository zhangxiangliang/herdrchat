// herdrchat's Telegram side. A bot cannot make groups (no such Bot API method), so each
// herdr-app tab is a topic in your private chat with the bot (topic mode must be on in
// @BotFather; getMe says has_topics_enabled), and the chat's main thread is the direct
// chat: the overview and the commands. In a space of HERDR_MUTED_SPACES (all, by
// default) the bot posts silently (a notification without sound) and `ring` sends a short
// reply that sounds, for "needs you" and "done"; a bot cannot mute a chat for you, so
// this stands in for Feishu's muted groups. Elsewhere every post sounds. A space of
// HERDR_SILENT_SPACES never sounds. The core (lib/core/engine.mjs) calls only what is returned here; the
// contract is lib/chats/contract.mjs.
//
// What Telegram does differently, and what stands in:
//   ended rooms   closeForumTopic is documented for supergroups only, so an ended
//                 topic's name gets a 🔚 in front, taken off when it is live again
//   images        a message cannot hold one, so each goes as its own photo after the text
//   buttons       callback_data holds 64 bytes, so a button carries a short id and the
//                 dialog it answers is kept in state.json
//   a free answer no text box on a message: you type the answer in the topic
//   pin           a topic cannot be pinned, so the dialog card is: pinned while it waits
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createClient } from './client.mjs';
import { escapeHtml, split, toHtml } from './format.mjs';

export const requires = ['TELEGRAM_BOT_TOKEN'];

const POLL_SECONDS = 50;
const RETRY_MS = 3000;
const ENDED_MARK = '🔚 ';
const NAME_MAX = 128;
const BUTTON_TEXT = 60;
const BUTTONS_KEPT = 300;
const WORKING_EMOJI = '👀';
const DONE_EMOJI = '👌';
// the topic icon colors Telegram allows (createForumTopic icon_color), one per space
const ICON_COLORS = [7322096, 16766590, 13338331, 9367192, 16749490, 16478047];
const STATES = { blocked: '⚠️', error: '🔴', working: '⌛️', done: '✅', idle: '❓' };
const RANK = { blocked: 0, error: 1, working: 2, done: 3, idle: 4 };
const COMMANDS = [
  { command: 'ls', description: 'a new overview of every terminal' },
  { command: 'new', description: '<session> <space>/<tab> [command]: start a terminal' },
  { command: 'kill', description: '<session> <address>: end a terminal' },
  { command: 'screen', description: 'in a topic: its terminal\'s screen' },
  { command: 'answer', description: 'in a topic: <text> answers what it waits on' },
  { command: 'esc', description: 'in a topic: press Esc' },
  { command: 'history', description: 'in a topic: the conversation so far, as a file' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// What to do after an edit to config.env, said the way this profile is run.
const startAgain = (cfg) => `\`herdrchat start${cfg.profile && cfg.profile !== 'default' ? ` --profile ${cfg.profile}` : ''}\``;

const inSpaces = (set, space) => set.all || set.spaces.includes(space);
const spaceOfName = (name) => (name || '').split(' / ')[0];
const cut = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export function create({ cfg, store, log, logWarn, logError, claimOwner = () => 'none' }) {
  const env = cfg.env || {};
  const owner = String(env.TELEGRAM_OWNER_ID || '').trim();
  const tg = createClient(env.TELEGRAM_BOT_TOKEN, { log: logWarn });
  const { read, write } = store;
  let username = '';

  // ---------- sending ----------

  // Images a post holds (from `image`) are kept here until the post goes out; the text
  // carries a mark where each was.
  const images = new Map();
  let imageN = 0;
  const IMAGE_MARK = /⁣img(\d+)⁣/g;
  function takeImages(markdown) {
    const found = [...(markdown || '').matchAll(IMAGE_MARK)].map((m) => m[1]);
    return { text: (markdown || '').replace(IMAGE_MARK, '').replace(/\n{3,}/g, '\n\n').trim(), found };
  }
  async function sendImages(room, ids) {
    let last = null;
    for (const id of ids) {
      const buffer = images.get(id);
      if (!buffer) continue;
      images.delete(id);
      last = String((await tg.sendPhoto(owner, room, buffer, { silent: quiet(room) })).message_id);
    }
    return last;
  }

  // Whether a room's posts go silently: its space is in HERDR_MUTED_SPACES.
  const muted = cfg.muted || { all: true, spaces: [] };
  function quiet(room) {
    const c = Object.values(read().chats).find((x) => x.chat === room);
    return !c || inSpaces(muted, spaceOfName(c.name));
  }

  // HTML that Telegram refuses (an entity it cannot parse) goes again as plain text.
  async function sendText(chatId, threadId, html, plain, { silent = true, extra = {} } = {}) {
    const base = { chat_id: chatId, ...(threadId ? { message_thread_id: Number(threadId) } : {}), disable_notification: silent, link_preview_options: { is_disabled: true }, ...extra };
    try {
      return await tg.queued('sendMessage', { ...base, text: html || '(empty)', parse_mode: 'HTML' });
    } catch (err) {
      if (err.code !== 400 || !/parse|entit/i.test(err.message)) throw err;
      logWarn(`telegram: HTML refused, sent as text (${err.message})`);
      return tg.queued('sendMessage', { ...base, text: plain || '(empty)' });
    }
  }

  async function post(room, markdown) {
    const { text, found } = takeImages(markdown);
    let last = null;
    if (text) for (const piece of split(text)) last = String((await sendText(owner, room, toHtml(piece), piece, { silent: quiet(room) })).message_id);
    return (await sendImages(room, found)) || last;
  }

  const lookHtml = ({ title, markdown }) => `<b>${escapeHtml(title)}</b>\n\n${toHtml(markdown)}`;

  async function postCard(room, look) {
    const { text, found } = takeImages(look.markdown);
    const message = String((await sendText(owner, room, lookHtml({ ...look, markdown: text }), `${look.title}\n\n${text}`, { silent: quiet(room) })).message_id);
    await sendImages(room, found);
    return message;
  }

  // An edit that changes nothing is refused by Telegram as "not modified": that is fine.
  async function edit(message, html, extra = {}) {
    try {
      await tg.queued('editMessageText', { chat_id: owner, message_id: Number(message), text: html, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra });
    } catch (err) {
      if (!/not modified/i.test(err.message)) throw err;
    }
  }

  // The room an edited card is in is not known here, so images added to it go to the
  // room the card was posted in, kept by message.
  const cardRoom = new Map();
  async function editCard(message, look) {
    const { text, found } = takeImages(look.markdown);
    await edit(message, lookHtml({ ...look, markdown: text }));
    if (found.length) await sendImages(cardRoom.get(String(message)) || null, found);
  }

  // ---------- dialogs ----------

  // A button carries "<id>:<pick>"; the id names the dialog's value (the newest
  // BUTTONS_KEPT; an older card is told its dialog is gone).
  // They are kept in state.json (buttons), so a card still answers after a restart.
  function keyboard(dialog, value) {
    const id = crypto.randomBytes(6).toString('base64url');
    const state = read();
    const kept = { ...(state.buttons || {}), [id]: { value, labels: Object.fromEntries(dialog.menu.options.map((o) => [o.n, o.label])) } };
    const ids = Object.keys(kept);
    for (const old of ids.slice(0, Math.max(0, ids.length - BUTTONS_KEPT))) delete kept[old];
    state.buttons = kept;
    write(state);
    const rows = [];
    for (const o of dialog.menu.options) {
      if (o === dialog.menu.free) continue;
      const box = o.checked === null || o.checked === undefined ? '' : o.checked ? '☑ ' : '☐ ';
      rows.push([{ text: cut(`${o.n}. ${box}${o.label}`, BUTTON_TEXT), callback_data: `${id}:${o.n}` }]);
    }
    if (dialog.menu.multi) rows.push([{ text: 'Next ⇥', callback_data: `${id}:tab` }]);
    rows.push([{ text: 'Esc (cancel)', callback_data: `${id}:esc` }]);
    return { inline_keyboard: rows };
  }
  const dialogHtml = (dialog) => `<b>${escapeHtml(dialog.title)}</b>\n\n${toHtml(dialog.markdown)}${dialog.menu?.free ? `\n\n<i>Or type your answer here (${escapeHtml(dialog.menu.free.label)}).</i>` : ''}`;
  const doneHtml = (dialog, done) => `<b>${escapeHtml(dialog.doneTitle)}</b>\n\n${toHtml(dialog.markdown)}\n\n<b>${escapeHtml(done)}</b>`;

  async function postDialog(room, dialog, value) {
    const res = await sendText(owner, room, dialogHtml(dialog), dialog.markdown, { silent: quiet(room), extra: { reply_markup: keyboard(dialog, value) } });
    return String(res.message_id);
  }

  async function closeDialog(message, dialog, done) {
    await edit(message, doneHtml(dialog, done), { reply_markup: { inline_keyboard: [] } });
  }

  // ---------- rooms ----------

  function iconOf(space) {
    const state = read();
    const spaces = state.spaces || {};
    if (spaces[space]?.icon) return spaces[space].icon;
    const used = Object.values(spaces).map((x) => x.icon);
    const icon = ICON_COLORS.find((c) => !used.includes(c)) || ICON_COLORS[used.length % ICON_COLORS.length];
    state.spaces = { ...spaces, [space]: { icon } };
    write(state);
    return icon;
  }

  async function openRoom({ name }) {
    const topic = await tg.queued('createForumTopic', { chat_id: owner, name: cut(name, NAME_MAX), icon_color: iconOf(spaceOfName(name)) });
    return String(topic.message_thread_id);
  }

  const renameTopic = (room, name) => tg.queued('editForumTopic', { chat_id: owner, message_thread_id: Number(room), name: cut(name, NAME_MAX) });

  async function renameRoom(room, name) {
    const c = Object.values(read().chats).find((x) => x.chat === room);
    await renameTopic(room, c?.ended ? ENDED_MARK + name : name);
  }

  const placeRoom = async () => {}; // a topic's color is set when it is made
  async function endRoom(k) {
    const c = read().chats[k];
    if (c) await renameTopic(c.chat, ENDED_MARK + c.name).catch((err) => logError(`ended mark on ${c.name}: ${err.message}`));
  }
  async function reviveRoom(k) {
    const c = read().chats[k];
    if (c) await renameTopic(c.chat, c.name).catch((err) => logError(`live again ${c.name}: ${err.message}`));
  }

  // ---------- attention ----------

  // A dialog card is pinned while it waits, as Feishu pins its group, and unpinned once
  // it is answered; which message is pinned for which room is kept in state.json (pinned).
  async function pin(k, room, message) {
    if (!message) return;
    try {
      await tg.queued('pinChatMessage', { chat_id: owner, message_id: Number(message), disable_notification: true });
      const state = read();
      state.pinned = { ...(state.pinned || {}), [k]: String(message) };
      write(state);
    } catch (err) {
      logError(`pin ${message}: ${err.message}`);
    }
  }
  async function unpin(k) {
    const message = read().pinned?.[k];
    if (!message) return;
    await tg.queued('unpinChatMessage', { chat_id: owner, message_id: Number(message) }).catch((err) => logError(`unpin ${message}: ${err.message}`));
    const state = read();
    delete state.pinned[k];
    write(state);
  }

  // In a quiet room this reply is what sounds; in another the post sounded already. A
  // space in HERDR_SILENT_SPACES never sounds.
  async function ring(k, message, text) {
    const c = read().chats[k];
    if (!message || !c || !quiet(c.chat) || inSpaces(cfg.silent, spaceOfName(c.name))) return;
    await sendText(owner, c.chat, escapeHtml(text), text, { silent: false, extra: { reply_parameters: { message_id: Number(message), allow_sending_without_reply: true } } })
      .catch((err) => logError(`ring: ${err.message}`));
  }

  const react = (message, emoji) => tg.queued('setMessageReaction', { chat_id: owner, message_id: Number(message), reaction: [{ type: 'emoji', emoji }] });
  async function markWorking(message) {
    await react(message, WORKING_EMOJI);
    return WORKING_EMOJI;
  }
  const markDone = async (message) => { await react(message, DONE_EMOJI); }; // one reaction per message: it replaces

  async function image(buffer) {
    const id = String((imageN += 1));
    images.set(id, buffer);
    return `⁣img${id}⁣`;
  }

  async function postFile(room, { name, data, caption }) {
    return String((await tg.sendDocument(owner, room, name, data, { caption })).message_id);
  }

  // An expandable quote: two or three lines shown, the rest on a tap. A quote cannot hold
  // code blocks or another quote, so the text goes in plain, escaped.
  async function postFolded(room, { title, markdown }) {
    const html = `<b>${escapeHtml(title)}</b>\n<blockquote expandable>${escapeHtml(markdown)}</blockquote>`;
    return String((await sendText(owner, room, html, `${title}\n\n${markdown}`)).message_id);
  }

  async function download(message, ref, file) {
    fs.writeFileSync(file, await tg.download(ref));
  }

  // `where` is "<chat>:<topic>" (topic empty: the main thread)
  async function reply(where, markdown) {
    const [chatId, thread] = String(where).split(':');
    let last = null;
    for (const piece of split(markdown)) last = String((await sendText(chatId, thread || null, toHtml(piece), piece)).message_id);
    return last;
  }

  async function tellOwner(look) {
    if (!owner) return;
    await sendText(owner, null, lookHtml(look), `${look.title}\n\n${look.markdown}`, { silent: false });
  }

  // ---------- the overview, in the main thread ----------

  function overviewHtml(rows) {
    const sorted = [...rows].sort((a, b) => (RANK[a.state] ?? 5) - (RANK[b.state] ?? 5) || a.name.localeCompare(b.name));
    const waiting = rows.filter((r) => r.state === 'blocked').length;
    const head = `<b>${waiting ? `⚠️ ${waiting} needs you · ` : ''}herdrchat · ${rows.length} terminals</b>`;
    if (!sorted.length) return `${head}\n\nNo terminal is shown in herdr-app.`;
    const lines = sorted.map((r) => {
      const name = r.room && username ? `<a href="https://t.me/${username}/${r.room}">${escapeHtml(r.name)}</a>` : escapeHtml(r.name);
      const word = STATES[r.state] ? `${r.state === 'blocked' ? 'needs you' : r.state}${r.state === 'blocked' && r.kind ? ` (${r.kind})` : ''}` : r.program || 'no status';
      const at = r.since ? ` · since ${new Date(r.since).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` : '';
      return `${STATES[r.state] || '❓'} <b>${name}</b> · ${escapeHtml(word)}${at} · <code>${escapeHtml(r.address)}</code>`;
    });
    return `${head}\n\n${lines.join('\n')}`;
  }

  // One overview message, edited in place (an edit never sounds); a fresh one (/ls) or
  // one that cannot be edited is sent again and the old one is deleted.
  let overviewShown = null;
  async function showOverview(rows, { fresh = false } = {}) {
    if (!owner) return;
    const html = overviewHtml(rows);
    if (html === overviewShown && !fresh) return;
    const old = read().overview?.message;
    if (old && !fresh) {
      try {
        await edit(old, html);
        overviewShown = html;
        return;
      } catch (err) {
        logWarn(`overview ${old} not edited (${err.message}); sending a new one`);
      }
    }
    const res = await sendText(owner, null, html, html.replace(/<[^>]+>/g, ''));
    const state = read();
    state.overview = { message: String(res.message_id) };
    write(state);
    overviewShown = html;
    if (old) await tg.queued('deleteMessage', { chat_id: owner, message_id: Number(old) }).catch(() => {});
  }

  // ---------- in ----------

  function largestPhoto(photo = []) {
    return [...photo].sort((a, b) => (b.width * b.height) - (a.width * a.height) || (b.file_size || 0) - (a.file_size || 0))[0]?.file_id;
  }

  async function handleMessage(m, onMessage) {
    if (m.from?.is_bot) return; // the bot's own service messages (a topic it made)
    const from = String(m.from?.id || '');
    const where = `${m.chat.id}:${m.is_topic_message ? m.message_thread_id : ''}`;
    if (!owner) {
      if (m.chat.type !== 'private') return;
      // Telegram sends /start when someone first opens the bot: a command is never a guess
      const paired = String(m.text || '').startsWith('/') ? 'none' : claimOwner(m.text, 'TELEGRAM_OWNER_ID', from);
      log(`owner not set; message from user id ${from} (pairing: ${paired})`);
      if (paired === 'ok') await reply(where, '✅ Paired: you are this bot\'s owner now. It starts again, and your terminals\' topics appear in a moment.\n\nThen: type in a terminal\'s topic to talk to it; here, /ls shows them all, /new starts one.');
      else if (paired === 'wrong') await reply(where, 'That is not the code. Send the 6 digits `herdrchat setup` shows.');
      else await reply(where, `Hello! This bot has no owner yet. Run \`herdrchat setup${cfg.profile && cfg.profile !== 'default' ? ` --profile ${cfg.profile}` : ''}\` and send me the code it shows; or add this line to ${cfg.configFile || 'config.env'} yourself and run ${startAgain(cfg)}:\n\n\`TELEGRAM_OWNER_ID=${from}\``);
      return;
    }
    if (from !== owner || String(m.chat.id) !== owner) {
      logWarn(`ignored message from ${from} in ${m.chat.id}`);
      return;
    }
    const text = String(m.text || m.caption || '').replace(new RegExp(`^(/\\w+)@${username}\\b`, 'i'), '$1').trim();
    const photo = largestPhoto(m.photo);
    if (!text && !photo) return; // a service message (a topic made or renamed)
    await onMessage({ room: m.is_topic_message ? String(m.message_thread_id) : null, where, message: String(m.message_id), text, images: photo ? [photo] : [] });
  }

  // A click: the button's dialog and pick, the core's answer, then the card as it is now
  // and the toast.
  async function handleClick(q, onAction) {
    const answer = (text) => tg.call('answerCallbackQuery', { callback_query_id: q.id, text: (text || '').slice(0, 200) }).catch(() => {});
    if (String(q.from?.id) !== owner) return answer('Only the owner can answer.');
    const [id, pickRaw] = String(q.data || '').split(':');
    const kept = read().buttons?.[id];
    const message = String(q.message?.message_id || '');
    if (!kept) {
      await edit(message, `${q.message?.text ? escapeHtml(q.message.text) : ''}\n\n<b>This card is too old to answer; see the newest card.</b>`, { reply_markup: { inline_keyboard: [] } }).catch(() => {});
      return answer('This dialog is gone.');
    }
    const pick = /^\d+$/.test(pickRaw) ? Number(pickRaw) : pickRaw;
    const out = await onAction({ value: { ...kept.value, pick, label: kept.labels[pick] }, message, answer: '' });
    if (out.card?.kind === 'done') await edit(message, doneHtml(out.card.dialog, out.card.done), { reply_markup: { inline_keyboard: [] } }).catch((err) => logError(`dialog card: ${err.message}`));
    if (out.card?.kind === 'dialog') await edit(message, dialogHtml(out.card.dialog), { reply_markup: keyboard(out.card.dialog, out.card.value) }).catch((err) => logError(`dialog card: ${err.message}`));
    await answer(out.toast.text);
  }

  // Long polling: getUpdates holds up to POLL_SECONDS for news; a failure waits RETRY_MS
  // and tries again (409: another copy of the bot polls the same token). Telegram keeps
  // what the bot has not confirmed for 24 hours, so nothing sent while it was away is
  // lost; which update it handled last is kept in state.json (telegramOffset), so after a
  // restart nothing is handled twice.
  function start({ onMessage, onAction, onReady = () => {} }) {
    let offset = read().telegramOffset || 0;
    let connected = false;
    (async () => {
      for (;;) {
        try {
          if (!username) {
            const me = await tg.call('getMe');
            username = me.username;
            if (!me.has_topics_enabled) logWarn(`telegram: topic mode is off for @${username}, so no topic can be made: open @BotFather, tap Open (its mini app), pick the bot, turn on Threaded Mode, then herdrchat start again`);
            await tg.call('setMyCommands', { commands: COMMANDS }).catch((err) => logWarn(`telegram commands: ${err.message}`));
          }
          // the token works and Telegram answers: in (the first poll may hold for a while)
          if (!connected) {
            connected = true;
            console.log(`[telegram] connected as @${username}`);
            onReady();
          }
          const updates = await tg.call('getUpdates', { offset, timeout: POLL_SECONDS, allowed_updates: ['message', 'callback_query'] }, { timeoutMs: (POLL_SECONDS + 15) * 1000 });
          for (const u of updates) {
            try {
              if (u.message) await handleMessage(u.message, onMessage);
              if (u.callback_query) await handleClick(u.callback_query, onAction);
            } catch (err) {
              logError(`telegram update ${u.update_id}:`, err);
              // a message that could not be handled: you are told, never left guessing
              const m = u.message;
              if (m && String(m.from?.id || '') === owner) await reply(`${m.chat.id}:${m.is_topic_message ? m.message_thread_id : ''}`, `⚠️ Not delivered: it could not be handled (${err.message}). Send it again; \`herdrchat logs\` has the details.`).catch(() => {});
            }
            // saved once handled: a crash halfway handles it again, never skips it
            offset = u.update_id + 1;
            const state = read();
            state.telegramOffset = offset;
            write(state);
          }
        } catch (err) {
          logError(`telegram poll: ${err.message}`);
          await sleep(RETRY_MS);
        }
      }
    })();
  }

  // the room a card was posted in, for images an edit adds
  const postCardKept = async (room, look) => {
    const message = await postCard(room, look);
    cardRoom.set(message, room);
    if (cardRoom.size > 500) cardRoom.delete(cardRoom.keys().next().value);
    return message;
  };

  return {
    name: 'telegram',
    ready: () => Boolean(owner),
    help: [],
    roomWord: 'topic',
    liveBytes: 3500, // a message holds 4096 characters after parsing
    split: (text) => split(text),
    start,
    command: async () => false,
    openRoom,
    renameRoom,
    placeRoom,
    endRoom,
    reviveRoom,
    post,
    postCard: postCardKept,
    editCard,
    postDialog,
    closeDialog,
    pin,
    unpin,
    pinned: () => Object.keys(read().pinned || {}),
    ring,
    markWorking,
    markDone,
    image,
    postFile,
    postFolded,
    foldedBytes: 3500, // a message holds 4096 characters after parsing
    download,
    reply,
    tellOwner,
    showOverview,
  };
}
