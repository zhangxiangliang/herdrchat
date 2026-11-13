// herdrchat's Feishu side: the rooms (rooms/: how tabs are laid out in groups, and what a
// group wears), the direct chat with the bot for the overview and commands, and, after
// /auth, acting as you (muted groups, your labels, pins, @ mentions). The core
// (lib/core/engine.mjs) calls only what is returned here; see "The chat side" there for
// what each call means.
import { ticksOf, createClient, chunk, doneCard, downloadImage, foldedCard, menuCard, messageParts, recallMessage, sendCard, sendFile, sendMarkdown, startEvents, textCard, updateCard, uploadImage } from './client.mjs';
import { overviewCard, overviewText } from './overview.mjs';
import { createUserAuth } from './userauth.mjs';
import { createDecor } from './rooms/decor.mjs';
import { createGroups } from './rooms/groups.mjs';

const YOU_CHECK_MS = 60 * 1000;
const OVERVIEW_TRIES = 3;
const WORKING_EMOJI = 'THINKING';
const DONE_EMOJI = 'OK';
const TONES = { working: 'blue', closed: 'grey', needs: 'red', done: 'grey', good: 'green', bad: 'red' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// What to do after an edit to config.env, said the way this profile is run.
const startAgain = (cfg) => `\`herdrchat start${cfg.profile && cfg.profile !== 'default' ? ` --profile ${cfg.profile}` : ''}\``;

// cfg: loadConfig(); store: {read, write} of state.json; lane(k, label, fn): runs fn in
// the room's lane, after what is queued for it; scopeOf(k): the session or machine a
// room's terminal belongs to (its tag and label).
export const requires = ['FEISHU_APP_ID', 'FEISHU_APP_SECRET'];

export function create({ cfg, store, log, logWarn, logError, stateDir, lane, scopeOf, claimOwner = () => 'none' }) {
  const client = createClient(cfg);
  const userAuth = createUserAuth(cfg, stateDir);
  const { read, write } = store;

  // ---------- acting as you (optional, after /auth) ----------

  // With your token (userauth.mjs) the bot does what only you can: mutes its groups,
  // puts each in one of your own labels (the session or machine; "ended" once the terminal
  // is gone) besides its bot tag, pins the group that needs you, and @-mentions you under
  // a card that needs you and under the turn's last answer, since in a muted group only a
  // mention rings. Without the token none of this happens. Whether it may act as you is
  // checked every YOU_CHECK_MS; when that turns on, every group is brought in line; when
  // it turns off, you are told once.
  let you = false;
  let youCheckedAt = 0;

  async function asYou() {
    if (Date.now() - youCheckedAt < YOU_CHECK_MS) return you;
    youCheckedAt = Date.now();
    const was = you;
    try {
      you = await userAuth.allowed();
    } catch (err) {
      // not known (Feishu not reached): it stays as it was, and is asked again soon
      youCheckedAt = Date.now() - YOU_CHECK_MS + 10 * 1000;
      logWarn(`acting as you: not checked (${err.message}); it stays ${you ? 'on' : 'off'}`);
      return you;
    }
    if (you && !was) {
      log('acting as you: on');
      setTimeout(() => rooms.alignAll(), 0);
    } else if (!you && was) {
      logWarn('acting as you: off');
      await tellOwner({ title: '⚠️ Needs you', tone: 'needs', markdown: 'The bot can no longer act as you (mute, labels, pin). Send `/auth` to allow it again.' }).catch(() => {});
    }
    return you;
  }

  // ---------- rooms ----------

  const decor = createDecor({ client, cfg, store, log, logError, userAuth, asYou });
  const rooms = createGroups({ client, cfg, store, logError, lane, scopeOf, userAuth, asYou, decor });

  // ---------- posting ----------

  const post = (room, markdown) => sendMarkdown(client, room, markdown);
  const card = ({ title, tone, markdown }) => textCard(markdown, title, TONES[tone] || 'blue');

  async function postCard(room, look) {
    const res = await sendCard(client, room, card(look));
    return res?.data?.message_id || null;
  }

  async function editCard(message, look) {
    await updateCard(client, message, card(look));
  }

  async function postDialog(room, dialog, value) {
    const res = await sendCard(client, room, menuCard({ title: dialog.title, markdown: dialog.markdown, menu: dialog.menu, value }));
    return res?.data?.message_id || null;
  }

  async function closeDialog(message, dialog, done) {
    await updateCard(client, message, doneCard(dialog.doneTitle, dialog.markdown, done));
  }

  async function addReaction(message, emoji) {
    const res = await client.im.v1.messageReaction.create({ path: { message_id: message }, data: { reaction_type: { emoji_type: emoji } } });
    return res?.data?.reaction_id;
  }

  const markWorking = (message) => addReaction(message, WORKING_EMOJI);

  async function markDone(message, token) {
    if (token) await client.im.v1.messageReaction.delete({ path: { message_id: message, reaction_id: token } });
    await addReaction(message, DONE_EMOJI);
  }

  // An image for a post: uploaded once, shown in the card's markdown.
  async function image(buffer) {
    return `![image](${await uploadImage(client, buffer)})`;
  }

  const postFile = (room, { name, data }) => sendFile(client, room, name, data);

  // A folded card that Feishu refuses goes as a plain post: never lost.
  async function postFolded(room, { title, markdown }) {
    try {
      const res = await sendCard(client, room, foldedCard(title, markdown));
      return res?.data?.message_id || null;
    } catch (err) {
      logWarn(`folded card refused (${err.message}); sent as a post`);
      return post(room, `**${title}**\n\n${markdown}`);
    }
  }

  async function download(message, ref, file) {
    await downloadImage(client, message, ref, file);
  }

  const reply = (where, markdown) => sendMarkdown(client, where, markdown);

  async function tellOwner(look) {
    await sendCard(client, cfg.ownerOpenId, card(look), 'open_id');
  }

  // ---------- the overview, in the direct chat ----------

  // One overview card (overview.mjs), edited in place; an edit that would change nothing
  // is skipped. Which message it is lives in state.json (overview). An edit that fails is
  // tried again (Feishu sometimes answers 500 for a moment); only when it keeps failing,
  // or when asked for a fresh one (/ls), a new one is sent and the old one is recalled, so
  // the chat never shows two.
  let overviewShown = null;
  async function showOverview(rows, { fresh = false } = {}) {
    if (!cfg.ownerOpenId) return;
    const text = overviewText(rows);
    if (text === overviewShown && !fresh) return;
    const look = overviewCard(rows, Date.now());
    const old = read().overview?.message;
    if (old && !fresh) {
      for (let attempt = 1; attempt <= OVERVIEW_TRIES; attempt += 1) {
        try {
          await updateCard(client, old, look);
          overviewShown = text;
          return;
        } catch (err) {
          logWarn(`overview ${old} not edited (${err.message}); ${attempt < OVERVIEW_TRIES ? 'trying again' : 'sending a new one'}`);
          if (attempt < OVERVIEW_TRIES) await sleep(1000 * 2 ** attempt);
        }
      }
    }
    const res = await sendCard(client, cfg.ownerOpenId, look, 'open_id');
    const state = read();
    state.overview = { message: res.data.message_id };
    write(state);
    overviewShown = text;
    if (old) await recallMessage(client, old).catch((err) => logError(`old overview ${old} not recalled (${err.message})`));
  }

  // ---------- in ----------

  // Messages (deduplicated, the owner's only) and card clicks, turned into the core's
  // shape: {room (null: the direct chat), where, message, text, images}.
  //
  // Feishu wants an event handled within 3 seconds or it pushes it again, so a message is
  // taken at once and then handled in its chat's own queue (in order). Whether Feishu
  // sends again what came while the bot was offline is not documented, so the bot looks
  // itself: per chat it keeps the time of the last message it handled (state.json
  // feishuRead), and at every connection it lists what came after that and handles what
  // it missed.
  const seen = new Set();
  const queues = new Map(); // chat -> its last queued message
  function queued(chatId, fn) {
    const next = (queues.get(chatId) || Promise.resolve()).then(fn).catch((err) => logError(`feishu message in ${chatId}:`, err));
    queues.set(chatId, next);
    next.then(() => { if (queues.get(chatId) === next) queues.delete(chatId); });
  }
  function markRead(chatId, at) {
    const state = read();
    if ((state.feishuRead?.[chatId] || 0) >= at) return;
    state.feishuRead = { ...(state.feishuRead || {}), [chatId]: at };
    write(state);
  }

  function start({ onMessage, onAction, onReady }) {
    const take = (data) => {
      const msg = data.message;
      if (seen.has(msg.message_id)) return;
      seen.add(msg.message_id);
      if (seen.size > 2000) seen.delete(seen.values().next().value);
      queued(msg.chat_id, async () => {
        // whatever goes wrong, you are told it did not get through, and it is not tried
        // again at every connection
        try {
          await handleMessage(data);
        } catch (err) {
          logError(`feishu message ${msg.message_id} in ${msg.chat_id}:`, err);
          if (data.sender?.sender_id?.open_id === cfg.ownerOpenId) await reply(msg.chat_id, `⚠️ Not delivered: it could not be handled (${err.message}). Send it again; \`herdrchat logs\` has the details.`).catch(() => {});
        }
        markRead(msg.chat_id, Number(msg.create_time) || Date.now());
      });
    };
    const handleMessage = async (data) => {
      const msg = data.message;
      const openId = data.sender?.sender_id?.open_id;
      if (!cfg.ownerOpenId) {
        if (msg.chat_type !== 'p2p') return;
        const said = messageParts(msg.message_type, msg.content)?.text || '';
        const paired = said.trim().startsWith('/') ? 'none' : claimOwner(said, 'FEISHU_OWNER_OPEN_ID', openId);
        log(`owner not set; message from open_id ${openId} (pairing: ${paired})`);
        if (paired === 'ok') await reply(msg.chat_id, '✅ Paired: you are this bot\'s owner now. It starts again, and your terminals\' groups appear in a moment.\n\nThen: type in a terminal\'s group to talk to it; here, /ls shows them all, /new starts one, /auth lets the bot mute its groups.');
        else if (paired === 'wrong') await reply(msg.chat_id, 'That is not the code. Send the 6 digits `herdrchat setup` shows.');
        else await reply(msg.chat_id, `Hello! This bot has no owner yet. Run \`herdrchat setup${cfg.profile && cfg.profile !== 'default' ? ` --profile ${cfg.profile}` : ''}\` and send me the code it shows; or add this line to ${cfg.configFile || 'config.env'} yourself and run ${startAgain(cfg)}:\n\n\`FEISHU_OWNER_OPEN_ID=${openId}\``);
        return;
      }
      if (openId !== cfg.ownerOpenId) {
        logWarn(`ignored message from ${openId}`);
        return;
      }
      const parts = messageParts(msg.message_type, msg.content);
      if (!parts) {
        await reply(msg.chat_id, `Not delivered: only text and images are passed on, not this (${msg.message_type}). Copy its text into a message.`);
        return;
      }
      const text = parts.text.replace(/@_user_\d+/g, '').trim();
      if (!text && !parts.images.length) return;
      await onMessage({ room: rooms.roomOf(msg), where: msg.chat_id, message: msg.message_id, text, images: parts.images });
    };
    // A click must be answered within 3 seconds; the core's answer becomes Feishu's
    // callback response: a toast and, when the card changes, its new form.
    const handleAction = async (data) => {
      if (data.operator?.open_id !== cfg.ownerOpenId) return { toast: { type: 'error', content: 'Only the owner can answer.' } };
      const value = data.action?.value || {};
      const form = data.action?.form_value;
      let ticks = null;
      if (value.pick === 'tab' && form) {
        ticks = ticksOf(form);
        // what each box sent, by type only (never what it says): to see the shape Feishu uses
        log(`card form: ${Object.entries(form).map(([n, v]) => `${n}=${typeof v}:${typeof v === 'boolean' ? v : String(v).length}`).join(' ') || 'empty'}`);
        // no box came back: the ticks are unknown, and a wrong answer is worse than none
        if (!ticks) return { toast: { type: 'error', content: 'No ticked box came through, so nothing was sent. Tick at least one, or answer it in herdr-app.' } };
      }
      const out = await onAction({ value, message: data.context?.open_message_id, answer: String(form?.answer || ''), ticks });
      const res = { toast: { type: out.toast.type, content: out.toast.text } };
      if (out.card?.kind === 'done') res.card = { type: 'raw', data: doneCard(out.card.dialog.doneTitle, out.card.dialog.markdown, out.card.done) };
      if (out.card?.kind === 'dialog') res.card = { type: 'raw', data: menuCard({ title: out.card.dialog.title, markdown: out.card.dialog.markdown, menu: out.card.dialog.menu, value: out.card.value }) };
      return res;
    };
    // What came while the bot was away: the owner's messages after the last one handled,
    // in every chat it reads (a chat with none handled yet starts from now).
    const catchUp = async () => {
      if (!cfg.ownerOpenId) return;
      const state = read();
      const chats = new Set([...rooms.roomChats(), ...Object.keys(state.feishuRead || {})]);
      for (const chatId of chats) {
        const since = state.feishuRead?.[chatId];
        if (!since) {
          markRead(chatId, Date.now());
          continue;
        }
        try {
          const res = await client.im.v1.message.list({ params: { container_id_type: 'chat', container_id: chatId, start_time: String(Math.floor(since / 1000)), sort_type: 'ByCreateTimeAsc', page_size: 50 } });
          const missed = (res?.data?.items || []).filter((m) => Number(m.create_time) > since && m.sender?.sender_type === 'user' && m.sender?.id === cfg.ownerOpenId && !seen.has(m.message_id));
          if (missed.length) log(`feishu: ${missed.length} message(s) in ${chatId} came while the bot was away`);
          const p2p = !rooms.isRoomChat(chatId);
          for (const m of missed) take({ message: { message_id: m.message_id, chat_id: chatId, chat_type: p2p ? 'p2p' : 'group', root_id: m.root_id, thread_id: m.thread_id, message_type: m.msg_type, content: m.body?.content || '{}', create_time: m.create_time }, sender: { sender_id: { open_id: m.sender.id } } });
        } catch (err) {
          logWarn(`feishu: could not look for missed messages in ${chatId}: ${err.message}`);
        }
      }
    };
    // The bot's menu (set in the developer console; direct chat only): an item that pushes
    // an event with key "ls", "help" or "auth" works as that command sent in the direct chat.
    const onMenu = async (data) => {
      const openId = data.operator?.operator_id?.open_id;
      const key = String(data.event_key || '').replace(/^\//, '');
      if (!cfg.ownerOpenId || openId !== cfg.ownerOpenId || !/^[a-z]+$/.test(key)) return;
      log(`feishu menu: /${key}`);
      queued('menu', () => onMessage({ room: null, where: `open_id:${openId}`, message: `menu-${data.timestamp || Date.now()}`, text: `/${key}`, images: [] }));
    };
    startEvents(cfg, take, handleAction, onReady, () => catchUp().catch((err) => logError(`feishu catch-up: ${err.message}`)), onMenu);
    setInterval(() => asYou().catch((err) => logError(`as you: ${err.message}`)), YOU_CHECK_MS);
    asYou().catch((err) => logError(`as you: ${err.message}`));
  }

  // `/auth`: the device flow, in the direct chat. The link opens Feishu's own consent
  // page; the bot waits for your yes in the background.
  async function authorize(where) {
    const device = await userAuth.startDeviceFlow();
    await reply(where, `Open this link and allow it (the code is ${device.user_code}):\n\n${device.verification_uri_complete || device.verification_uri}\n\nIt lets the bot mute its groups for you, put them in your labels and pin the one that needs you. Nothing else.`);
    userAuth.waitForToken(device)
      .then(async (t) => {
        await reply(where, `✅ Allowed${t.refresh ? '' : ' (no refresh token: it lasts about two hours)'}. Muting the groups and putting them in your labels now.`);
        youCheckedAt = 0;
        await asYou();
      })
      .catch((err) => reply(where, `Not allowed: ${err.message}`));
  }

  // Commands only Feishu has, in the direct chat; true when it was one.
  async function command(cmd, args, where) {
    if (cmd !== '/auth') return false;
    await authorize(where);
    return true;
  }

  return {
    name: 'feishu',
    ready: () => Boolean(cfg.ownerOpenId),
    help: ['`/auth` let the bot act as you for chat-list settings (mute, labels, pin)'],
    roomWord: rooms.roomWord,
    liveBytes: 20000, // a card may hold 30 KB; room for JSON escaping
    split: (text) => chunk(text),
    start,
    command,
    openRoom: rooms.openRoom,
    renameRoom: rooms.renameRoom,
    placeRoom: rooms.placeRoom,
    endRoom: rooms.endRoom,
    reviveRoom: rooms.reviveRoom,
    post,
    postCard,
    editCard,
    postDialog,
    closeDialog,
    pin: rooms.pin,
    unpin: rooms.unpin,
    pinned: rooms.pinned,
    ring: rooms.ring,
    markWorking,
    markDone,
    image,
    postFile,
    postFolded,
    foldedBytes: 20000, // a card may hold 30 KB
    download,
    reply,
    tellOwner,
    showOverview,
  };
}
