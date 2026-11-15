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
import * as words from '../../core/words.mjs';
import { buttonsKeyboard, cut, dialogHtml, dialogKeyboard, doneHtml, escapeHtml, foldedHtml, footHtml, footPlain, bytesOf, dialogText, lookOf, messagesOf, overviewHtml, quoteOf, splitBody } from './render.mjs';

export const requires = ['TELEGRAM_BOT_TOKEN'];

const POLL_SECONDS = 50;
const RETRY_MS = 3000;
const ENDED_MARK = '🔚 ';
const NAME_MAX = 128;
const BUTTONS_KEPT = 300;
const WORKING_EMOJI = '👀';
const DONE_EMOJI = '👌';
// the topic icon colors Telegram allows (createForumTopic icon_color), one per space
const ICON_COLORS = [7322096, 16766590, 13338331, 9367192, 16749490, 16478047];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const inSpaces = (set, space) => set.all || set.spaces.includes(space);
const spaceOfName = (name) => (name || '').split(' / ')[0];

export function create({ cfg, store, log, logWarn, logError, claimOwner = () => 'none' }) {
  const env = cfg.env || {};
  const owner = String(env.TELEGRAM_OWNER_ID || '').trim();
  const tg = createClient(env.TELEGRAM_BOT_TOKEN, { log: logWarn });
  const { read, write } = store;
  let username = '';

  // ---------- sending ----------

  // Images a post holds (from `image`: its image blocks' refs) are kept here until the
  // post goes out, as photos after its text; one sent is let go, so a live card edited
  // again does not send it twice.
  const images = new Map();
  let imageN = 0;
  async function sendImages(room, ids) {
    let last = null;
    for (const id of ids) {
      const buffer = images.get(id);
      if (!buffer) continue;
      images.delete(id);
      try {
        last = String((await tg.sendPhoto(owner, room, buffer, { silent: quiet(room) })).message_id);
      } catch (err) {
        // a photo Telegram will not take (PHOTO_INVALID_DIMENSIONS: a long screenshot; too
        // big) goes as a file, so it is not lost
        if (err.code !== 400 && err.code !== 413) throw err;
        logWarn(`telegram: image refused as a photo, sent as a file (${err.message})`);
        last = String((await tg.sendDocument(owner, room, imageName(buffer), buffer)).message_id);
      }
    }
    return last;
  }
  const imageName = (b) => (b[0] === 0xff && b[1] === 0xd8 ? 'image.jpg' : b[0] === 0x47 && b[1] === 0x49 ? 'image.gif' : b[0] === 0x52 && b[8] === 0x57 ? 'image.webp' : 'image.png');

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

  // What a ring on a message quotes (quoteOf), by message, for the ones sent lately.
  const quotes = new Map();
  function sent(res, html) {
    const message = String(res.message_id);
    quotes.set(message, quoteOf(html));
    if (quotes.size > 300) quotes.delete(quotes.keys().next().value);
    return message;
  }

  async function post(room, body, { footer } = {}) {
    const { messages, found } = messagesOf(body);
    let last = null;
    for (const [i, m] of messages.entries()) {
      const foot = i === messages.length - 1 ? footer : '';
      last = sent(await sendText(owner, room, m.html + footHtml(foot), m.plain + footPlain(foot), { silent: quiet(room) }), m.html);
    }
    return (await sendImages(room, found)) || last;
  }

  async function postCard(room, look) {
    const { html, plain, found } = lookOf(look);
    const message = sent(await sendText(owner, room, html, plain, { silent: quiet(room) }), html);
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
    const { html, found } = lookOf(look);
    await edit(message, html);
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
    return dialogKeyboard(dialog, id);
  }

  async function postDialog(room, dialog, value) {
    const html = dialogHtml(dialog);
    return sent(await sendText(owner, room, html, dialogText(dialog).plain, { silent: quiet(room), extra: { reply_markup: keyboard(dialog, value) } }), html);
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
  // One that fails is kept, so the core tries it again (an unpin lost to a dropped
  // connection left a card pinned for good); one Telegram no longer has (400) is let go.
  async function unpin(k) {
    const message = read().pinned?.[k];
    if (!message) return;
    try {
      await tg.queued('unpinChatMessage', { chat_id: owner, message_id: Number(message) });
    } catch (err) {
      logError(`unpin ${message}: ${err.message}`);
      if (err.code !== 400) return;
    }
    const state = read();
    delete state.pinned[k];
    write(state);
  }

  // In a quiet room this reply is what sounds; in another the post sounded already. A
  // space in HERDR_SILENT_SPACES never sounds. It quotes the message's first line only
  // (quoteOf), not the whole of it with its footer; one Telegram will not take as a quote
  // goes again without it.
  async function ring(k, message, text) {
    const c = read().chats[k];
    if (!message || !c || !quiet(c.chat) || inSpaces(cfg.silent, spaceOfName(c.name))) return;
    const quote = quotes.get(String(message));
    const send = (q) => sendText(owner, c.chat, escapeHtml(text), text, { silent: false, extra: { reply_parameters: { message_id: Number(message), allow_sending_without_reply: true, ...(q ? { quote: q.text, ...(q.entities.length ? { quote_entities: q.entities } : {}) } : {}) } } });
    await send(quote)
      .catch((err) => {
        if (!quote || err.code !== 400) throw err;
        logWarn(`ring: quote not taken (${err.message}); sent without it`);
        return send(null);
      })
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
    return id;
  }

  async function postFile(room, { name, data, caption }) {
    return String((await tg.sendDocument(owner, room, name, data, { caption })).message_id);
  }

  // an expandable quote (foldedHtml)
  async function postFolded(room, { title, markdown }) {
    return String((await sendText(owner, room, foldedHtml(title, markdown), `${title}\n\n${markdown}`)).message_id);
  }

  async function download(message, ref, file) {
    fs.writeFileSync(file, await tg.download(ref));
  }

  // `where` is "<chat>:<topic>" (topic empty: the main thread)
  async function reply(where, body) {
    const [chatId, thread] = String(where).split(':');
    let last = null;
    const { messages } = messagesOf(body);
    for (const m of messages.length ? messages : [{ html: '', plain: '' }]) last = String((await sendText(chatId, thread || null, m.html, m.plain)).message_id);
    return last;
  }

  // look.buttons: [{label, value}], kept as a dialog's are, so a tap sends the value
  async function tellOwner(look) {
    if (!owner) return;
    let extra = {};
    if (look.buttons?.length) {
      const id = crypto.randomBytes(6).toString('base64url');
      const state = read();
      state.buttons = { ...(state.buttons || {}), [id]: { value: {}, labels: {}, picks: Object.fromEntries(look.buttons.map((b, i) => [i, b.value])) } };
      write(state);
      extra = { reply_markup: buttonsKeyboard(look.buttons, id) };
    }
    const { html, plain } = lookOf(look);
    await sendText(owner, null, html, plain, { silent: false, extra });
  }

  // ---------- the overview, in the main thread ----------

  // One overview message, edited in place (an edit never sounds); a fresh one (/ls) or
  // one that cannot be edited is sent again and the old one is deleted. An edit that did
  // not get through is tried again later (the core), not sent as a second overview.
  let overviewShown = null;
  async function showOverview(rows, { fresh = false } = {}) {
    if (!owner) return;
    const html = overviewHtml(rows, username);
    if (html === overviewShown && !fresh) return;
    const old = read().overview?.message;
    if (old && !fresh) {
      try {
        await edit(old, html);
        overviewShown = html;
        return;
      } catch (err) {
        if (err.unreached) throw err;
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
      if (paired === 'ok') await reply(where, words.paired('topic'));
      else if (paired === 'wrong') await reply(where, words.NOT_THE_CODE);
      else await reply(where, words.noOwner({ profile: cfg.profile, configFile: cfg.configFile, line: `TELEGRAM_OWNER_ID=${from}` }));
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
    if (String(q.from?.id) !== owner) return answer(words.ONLY_OWNER);
    const [id, pickRaw] = String(q.data || '').split(':');
    const kept = read().buttons?.[id];
    const message = String(q.message?.message_id || '');
    if (!kept) {
      await edit(message, `${q.message?.text ? escapeHtml(q.message.text) : ''}\n\n<b>${escapeHtml(words.CARD_TOO_OLD)}</b>`, { reply_markup: { inline_keyboard: [] } }).catch(() => {});
      return answer(words.DIALOG_GONE);
    }
    const pick = /^\d+$/.test(pickRaw) ? Number(pickRaw) : pickRaw;
    const out = await onAction({ value: kept.picks ? kept.picks[pick] || {} : { ...kept.value, pick, label: kept.labels[pick] }, message, answer: '' });
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
            await tg.call('setMyCommands', { commands: words.COMMANDS }).catch((err) => logWarn(`telegram commands: ${err.message}`));
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
              if (m && String(m.from?.id || '') === owner) await reply(`${m.chat.id}:${m.is_topic_message ? m.message_thread_id : ''}`, words.couldNotHandle(err.message)).catch(() => {});
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
    liveBytes: 3500, // a message holds 4096 characters after parsing; bytesOf counts its HTML
    bytes: bytesOf,
    split: splitBody,
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
