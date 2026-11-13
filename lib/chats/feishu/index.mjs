// herdrchat's Feishu side: one group per tab (a "room" to the core), the direct chat with
// the bot for the overview and commands, and what only Feishu has: tenant tags, group
// avatars, and, after /auth, acting as you (muted groups, your labels, pins, @ mentions).
// The core (lib/core/engine.mjs) calls only what is returned here; see "The chat side"
// there for what each call means.
import { ticksOf, createClient, bindTag, chunk, createChat, createTag, doneCard, downloadImage, foldedCard, menuCard, messageParts, recallMessage, renameChat, replyMention, sendCard, sendFile, sendMarkdown, setChatAvatar, startEvents, tagName, textCard, unbindTag, updateCard, uploadImage } from './client.mjs';
import { COLORS, avatarPng, letterOf } from './avatar.mjs';
import { overviewCard, overviewText } from './overview.mjs';
import { createUserAuth } from './userauth.mjs';

const ENDED_TAG = '#ended';
const ENDED_LABEL = 'ended';
const YOU_CHECK_MS = 60 * 1000;
const OVERVIEW_TRIES = 3;
const WORKING_EMOJI = 'THINKING';
const DONE_EMOJI = 'OK';
const TONES = { working: 'blue', closed: 'grey', needs: 'red', done: 'grey', good: 'green', bad: 'red' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// What to do after an edit to config.env, said the way this profile is run.
const startAgain = (cfg) => `\`herdrchat start${cfg.profile && cfg.profile !== 'default' ? ` --profile ${cfg.profile}` : ''}\``;

const inSpaces = (set, space) => set.all || set.spaces.includes(space);
const spaceOfName = (name) => (name || '').split(' / ')[0];

// cfg: loadConfig(); store: {read, write} of state.json; lane(k, label, fn): runs fn in
// the room's lane, after what is queued for it; scopeOf(k): the session or machine a
// room's terminal belongs to (its tag and label).
export const requires = ['FEISHU_APP_ID', 'FEISHU_APP_SECRET'];

export function create({ cfg, store, log, logWarn, logError, stateDir, lane, scopeOf, claimOwner = () => 'none' }) {
  const client = createClient(cfg);
  const userAuth = createUserAuth(cfg, stateDir);
  const { read, write } = store;

  function setRoom(k, fields) {
    const state = read();
    if (state.chats[k]) state.chats[k] = { ...state.chats[k], ...fields };
    write(state);
  }

  // Lanes run side by side: a thing that is made once (a tag, a space's avatar) is made
  // by the first lane that needs it; the others wait for that.
  const making = new Map();
  function once(id, make) {
    if (!making.has(id)) making.set(id, make().finally(() => making.delete(id)));
    return making.get(id);
  }

  // ---------- tags and avatars ----------

  // One tenant tag per session or machine, made once, and one "ended" tag; their ids are
  // kept in state.json (tags).
  async function tagOf(id, name = id) {
    return read().tags?.[id] || once(`tag ${id}`, async () => {
      const tag = await createTag(client, name);
      const state = read();
      state.tags = { ...(state.tags || {}), [id]: tag };
      write(state);
      log(`created tag ${name} (${tag})`);
      return tag;
    });
  }

  // Each space gets an avatar: its first letter on a color of its own (the first color no
  // other space has), kept in state.json (spaces), so all of its groups look alike, as in
  // herdr-app. The color is picked and saved before the first await, so spaces made side
  // by side never pick the same one. A failure is logged and tried again at the next check.
  function colorOf(space) {
    const state = read();
    const spaces = state.spaces || {};
    if (spaces[space]?.color) return spaces[space].color;
    const used = Object.values(spaces).map((x) => x.color);
    const color = COLORS.find((c) => !used.includes(c)) || COLORS[used.length % COLORS.length];
    state.spaces = { ...spaces, [space]: { color } };
    write(state);
    return color;
  }

  async function avatarOf(space) {
    return read().spaces?.[space]?.image || once(`avatar ${space}`, async () => {
      const color = colorOf(space);
      const image = await uploadImage(client, await avatarPng(letterOf(space), color), 'avatar');
      const state = read();
      state.spaces = { ...(state.spaces || {}), [space]: { color, image } };
      write(state);
      log(`made avatar for space ${space} (${color})`);
      return image;
    });
  }

  // the space's avatar; a no-op when the group has it, so it follows a space that changes
  async function avatarRoom(k, space) {
    const c = read().chats[k];
    if (!c) return;
    try {
      const image = await avatarOf(space);
      if (c.avatar === image) return;
      await setChatAvatar(client, c.chat, image);
      setRoom(k, { avatar: image });
    } catch (err) {
      logError(`avatar ${space} on ${c.chat}: ${err.message}`);
    }
  }

  // Bot tags (HERDR_BOT_TAGS): the session or machine tag next to a group's name and, once
  // its terminal is gone, "ended". They are tenant tags, so they can be turned off; off
  // takes off the ones already on. A failure is logged and tried again at the next check.
  async function syncBotTags(k, scope) {
    const c = read().chats[k];
    if (!c) return;
    try {
      if (cfg.botTags) {
        const tag = await tagOf(scope);
        if (c.tag !== tag) {
          await bindTag(client, tag, c.chat);
          setRoom(k, { tag });
        }
        if (Boolean(c.ended) !== Boolean(c.endedTag)) {
          const ended = await tagOf(ENDED_TAG, 'ended');
          await (c.ended ? bindTag : unbindTag)(client, ended, c.chat);
          setRoom(k, { endedTag: Boolean(c.ended) });
        }
      } else {
        const tags = read().tags || {};
        if (c.tag) {
          await unbindTag(client, c.tag, c.chat).catch(() => {});
          setRoom(k, { tag: null });
        }
        if (c.endedTag && tags[ENDED_TAG]) {
          await unbindTag(client, tags[ENDED_TAG], c.chat).catch(() => {});
          setRoom(k, { endedTag: false });
        }
      }
    } catch (err) {
      logError(`bot tags on ${c.name}: ${err.message}`);
    }
  }

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
    you = await userAuth.allowed();
    if (you && !was) {
      log('acting as you: on');
      setTimeout(alignAll, 0);
    } else if (!you && was) {
      logWarn('acting as you: off');
      await tellOwner({ title: '⚠️ Needs you', tone: 'needs', markdown: 'The bot can no longer act as you (mute, labels, pin). Send `/auth` to allow it again.' }).catch(() => {});
    }
    return you;
  }

  async function labelOf(name) {
    return read().labels?.[name] || once(`label ${name}`, async () => {
      const found = (await userAuth.feedGroups())?.groups?.find((g) => g.name === name);
      const id = found?.group_id || (await userAuth.createFeedGroup(name))?.group_id;
      if (!id) throw new Error(`no label ${name}`);
      const state = read();
      state.labels = { ...(state.labels || {}), [name]: id };
      write(state);
      log(`label ${name} (${id})`);
      return id;
    });
  }

  // A label you deleted is made again at the next try.
  async function intoLabel(name, chat) {
    try {
      await userAuth.addToFeedGroup(await labelOf(name), [chat]);
    } catch (err) {
      const state = read();
      if (state.labels) delete state.labels[name];
      write(state);
      throw err;
    }
  }

  // Your label (HERDR_USER_TAGS, acting as you): the session or machine, or "ended" once
  // the terminal is gone; off takes the group out of it (the label itself is yours).
  async function syncUserLabel(k, scope) {
    if (!(await asYou())) return;
    const c = read().chats[k];
    if (!c) return;
    const want = cfg.userTags ? (c.ended ? ENDED_LABEL : tagName(scope)) : null;
    if ((c.label || null) === want) return;
    try {
      if (c.label) await userAuth.removeFromFeedGroup(await labelOf(c.label), [c.chat]).catch(() => {});
      if (want) await intoLabel(want, c.chat);
      setRoom(k, { label: want });
    } catch (err) {
      logError(`as you, label of ${c.name}: ${err.message}`);
    }
  }

  // HERDR_MUTED_SPACES says which groups are muted (all, none, or some spaces); a change
  // in config.env is applied both ways at the next start.
  async function muteRoom(k, space) {
    const c = read().chats[k];
    const want = inSpaces(cfg.muted, space);
    if (!c || Boolean(c.muted) === want) return;
    try {
      await userAuth.setMuted([c.chat], want);
      setRoom(k, { muted: want });
    } catch (err) {
      logError(`as you, mute ${c.chat}: ${err.message}`);
    }
  }

  // Everything at once, when acting as you turns on: live groups to their labels, ended
  // ones to "ended".
  function alignAll() {
    for (const [k, c] of Object.entries(read().chats)) {
      if (!cfg.sessions.includes(c.session)) continue;
      lane(k, 'as you', () => (c.ended ? endRoom(k) : placeRoom(k, { space: spaceOfName(c.name) })));
    }
  }

  // ---------- rooms ----------

  // One group per tab, with you in it; what you type there goes to its terminal.
  async function openRoom({ name, intro }) {
    return createChat(client, cfg.ownerOpenId, name, intro);
  }

  async function renameRoom(room, name) {
    await renameChat(client, room, name);
  }

  // Puts a live group where it belongs: its avatar, its bot tag and, acting as you, muted
  // and in your label. Cheap when nothing is left to do.
  async function placeRoom(k, { space }) {
    await avatarRoom(k, space);
    await syncBotTags(k, scopeOf(k));
    if (!(await asYou())) return;
    await muteRoom(k, space);
    await syncUserLabel(k, scopeOf(k));
  }

  // A group whose terminal is gone keeps its history, tagged "ended".
  async function endRoom(k) {
    const c = read().chats[k];
    if (!c) return;
    await syncBotTags(k, scopeOf(k));
    if (!c.avatar) await avatarRoom(k, spaceOfName(c.name));
    if (!(await asYou())) return;
    await muteRoom(k, spaceOfName(c.name));
    await syncUserLabel(k, scopeOf(k));
  }

  async function reviveRoom(k) {
    await syncBotTags(k, scopeOf(k));
    await syncUserLabel(k, scopeOf(k));
  }

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

  // The group that needs you is pinned while it waits (acting as you), and unpinned when
  // it no longer does; which ones are pinned is kept in state.json (pinned).
  async function pin(k, room) {
    if (!(await asYou())) return;
    try {
      await userAuth.pin(room);
      const state = read();
      state.pinned = { ...(state.pinned || {}), [k]: room };
      write(state);
    } catch (err) {
      logError(`pin ${room}: ${err.message}`);
    }
  }

  async function unpin(k) {
    const room = read().pinned?.[k];
    if (!room) return;
    try {
      await userAuth.unpin(room);
    } catch (err) {
      logError(`unpin ${room}: ${err.message}`);
    }
    const state = read();
    delete state.pinned[k];
    write(state);
  }

  const pinned = () => Object.keys(read().pinned || {});

  // In a muted group only a mention rings; a group that is not muted rings anyway. A
  // space in HERDR_SILENT_SPACES gets no mention at all.
  async function ring(k, message, text) {
    const c = read().chats[k];
    if (!message || !c?.muted || inSpaces(cfg.silent, spaceOfName(c.name)) || !(await asYou())) return;
    await replyMention(client, message, cfg.ownerOpenId, text).catch((err) => logError(`mention: ${err.message}`));
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
        await handleMessage(data);
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
        await reply(msg.chat_id, 'Only text and images are passed on.');
        return;
      }
      const text = parts.text.replace(/@_user_\d+/g, '').trim();
      if (!text && !parts.images.length) return;
      await onMessage({ room: msg.chat_type === 'p2p' ? null : msg.chat_id, where: msg.chat_id, message: msg.message_id, text, images: parts.images });
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
      const chats = new Set([...Object.values(state.chats || {}).filter((c) => !c.ended).map((c) => c.chat), ...Object.keys(state.feishuRead || {})]);
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
          const p2p = !Object.values(state.chats || {}).some((c) => c.chat === chatId);
          for (const m of missed) take({ message: { message_id: m.message_id, chat_id: chatId, chat_type: p2p ? 'p2p' : 'group', message_type: m.msg_type, content: m.body?.content || '{}', create_time: m.create_time }, sender: { sender_id: { open_id: m.sender.id } } });
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
    roomWord: 'group',
    liveBytes: 20000, // a card may hold 30 KB; room for JSON escaping
    split: (text) => chunk(text),
    start,
    command,
    openRoom,
    renameRoom,
    placeRoom,
    endRoom,
    reviveRoom,
    post,
    postCard,
    editCard,
    postDialog,
    closeDialog,
    pin,
    unpin,
    pinned,
    ring,
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
