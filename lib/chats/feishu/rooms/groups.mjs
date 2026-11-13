// One Feishu group per herdr-app tab, with you in it; what you type there goes to its
// terminal. A room is the group's chat id. The group wears its space's avatar, its tags
// and, acting as you, its mute and your label (decor.mjs); the group that needs you is
// pinned. index.mjs calls only what is returned here.
import { createChat, renameChat, replyMention } from '../client.mjs';
import { inSpaces, spaceOfName } from './decor.mjs';

export function createGroups({ client, cfg, store, logError, lane, scopeOf, userAuth, asYou, decor }) {
  const { read, write } = store;
  const entryOf = (k) => ({
    get: () => read().chats[k],
    set: (fields) => {
      const state = read();
      if (state.chats[k]) state.chats[k] = { ...state.chats[k], ...fields };
      write(state);
    },
  });

  async function openRoom({ name, intro }) {
    return createChat(client, cfg.ownerOpenId, name, intro);
  }

  async function renameRoom(room, name) {
    await renameChat(client, room, name);
  }

  // Puts a live group where it belongs: its avatar, its bot tag and, acting as you, muted
  // and in your label. Cheap when nothing is left to do.
  async function placeRoom(k, { space }) {
    const entry = entryOf(k);
    await decor.avatar(entry, space);
    await decor.botTags(entry, scopeOf(k));
    if (!(await asYou())) return;
    await decor.mute(entry, space);
    await decor.userLabel(entry, scopeOf(k));
  }

  // A group whose terminal is gone keeps its history, tagged "ended".
  async function endRoom(k) {
    const entry = entryOf(k);
    const c = entry.get();
    if (!c) return;
    await decor.botTags(entry, scopeOf(k));
    if (!c.avatar) await decor.avatar(entry, spaceOfName(c.name));
    if (!(await asYou())) return;
    await decor.mute(entry, spaceOfName(c.name));
    await decor.userLabel(entry, scopeOf(k));
  }

  async function reviveRoom(k) {
    const entry = entryOf(k);
    await decor.botTags(entry, scopeOf(k));
    await decor.userLabel(entry, scopeOf(k));
  }

  // Everything at once, when acting as you turns on: live groups to their labels, ended
  // ones to "ended".
  function alignAll() {
    for (const [k, c] of Object.entries(read().chats)) {
      if (!cfg.sessions.includes(c.session)) continue;
      lane(k, 'as you', () => (c.ended ? endRoom(k) : placeRoom(k, { space: spaceOfName(c.name) })));
    }
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

  // A message, to the core's words: the room it came from (null: the direct chat).
  const roomOf = (msg) => (msg.chat_type === 'p2p' ? null : msg.chat_id);
  // The chats whose messages the bot reads (to look for what it missed), and whether a
  // chat is one of them rather than the direct chat.
  const roomChats = () => Object.values(read().chats || {}).filter((c) => !c.ended).map((c) => c.chat);
  const isRoomChat = (chatId) => Object.values(read().chats || {}).some((c) => c.chat === chatId);

  return { roomWord: 'group', openRoom, renameRoom, placeRoom, endRoom, reviveRoom, alignAll, pin, unpin, pinned, ring, roomOf, roomChats, isRoomChat };
}
