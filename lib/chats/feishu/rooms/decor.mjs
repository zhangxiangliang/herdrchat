// What a Feishu group wears (groups.mjs makes one per tab): the space's avatar, the bot
// tags, and, acting as you, your labels and its mute. Each call takes an `entry`,
// {get() -> record, set(fields)}: the record of the group in state.json, {chat, name,
// avatar, tag, ended, endedTag, label, inAll, muted}.
import { bindTag, createTag, setChatAvatar, unbindTag, uploadImage } from '../client.mjs';
import { COLORS, avatarPng, letterOf } from '../avatar.mjs';

// Two names only, for the bot's tags and your labels alike: "herdr" on every group of the
// bot's, ended or not, and "herdr-ended" too once its terminal is gone. Set your "herdr"
// label to "never show" in the client (right click > 消息展示设置) and none of them is in
// the message list. (Before, a tag and a label per session or machine, and "ended": a
// group that has one is moved off it.)
const ALL_TAG = '#herdr';
const ENDED_TAG = '#herdr-ended';
const OLD_ENDED_TAG = '#ended';
const ALL_LABEL = 'herdr';
const ENDED_LABEL = 'herdr-ended';

export const inSpaces = (set, space) => set.all || set.spaces.includes(space);
export const spaceOfName = (name) => (name || '').split(' / ')[0];

// asYou() -> whether the bot may act as you now (index.mjs keeps that)
export function createDecor({ client, cfg, store, log, logError, userAuth, asYou }) {
  const { read, write } = store;

  // Lanes run side by side: a thing that is made once (a tag, a space's avatar) is made
  // by the first lane that needs it; the others wait for that.
  const making = new Map();
  function once(id, make) {
    if (!making.has(id)) making.set(id, make().finally(() => making.delete(id)));
    return making.get(id);
  }

  // ---------- tags and avatars ----------

  // The tenant tags, each made once; their ids are kept in state.json (tags).
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
  async function avatar(entry, space) {
    const c = entry.get();
    if (!c) return;
    try {
      const image = await avatarOf(space);
      if (c.avatar === image) return;
      await setChatAvatar(client, c.chat, image);
      entry.set({ avatar: image });
    } catch (err) {
      logError(`avatar ${space} on ${c.chat}: ${err.message}`);
    }
  }

  // Bot tags (HERDR_BOT_TAGS): "herdr" next to every group's name and, once its terminal
  // is gone, "herdr-ended" too (with /auth or without: what every member sees). They are
  // tenant tags, so they can be turned off; off takes off the ones already on. The record
  // keeps the tag ids a group has (tag, endedTag; endedTag `true` from before is the old
  // "ended" tag), so one from before is taken off when the new one goes on. A failure is
  // logged and tried again at the next check.
  async function botTags(entry) {
    const c = entry.get();
    if (!c) return;
    const hadEnded = c.endedTag === true ? read().tags?.[OLD_ENDED_TAG] || null : c.endedTag || null;
    try {
      const tag = cfg.botTags ? await tagOf(ALL_TAG, 'herdr') : null;
      if ((c.tag || null) !== tag) {
        if (c.tag) await unbindTag(client, c.tag, c.chat).catch(() => {});
        if (tag) await bindTag(client, tag, c.chat);
        entry.set({ tag });
      }
      const ended = cfg.botTags && c.ended ? await tagOf(ENDED_TAG, 'herdr-ended') : null;
      if (hadEnded !== ended) {
        if (hadEnded) await unbindTag(client, hadEnded, c.chat).catch(() => {});
        if (ended) await bindTag(client, ended, c.chat);
        entry.set({ endedTag: ended });
      }
    } catch (err) {
      logError(`bot tags on ${c.name}: ${err.message}`);
    }
  }

  // ---------- acting as you ----------

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

  // Your labels (HERDR_USER_TAGS, acting as you): "herdr", every group's, ended or not
  // (inAll), and "ended" once the terminal is gone. No label per session or machine: the
  // bot's tag says that next to the name. A group in one from before is taken out of it.
  // Off takes the group out of them (the labels themselves are yours).
  async function userLabel(entry) {
    if (!(await asYou())) return;
    const c = entry.get();
    if (!c) return;
    const want = cfg.userTags && c.ended ? ENDED_LABEL : null;
    if ((c.label || null) !== want) {
      try {
        if (c.label) await userAuth.removeFromFeedGroup(await labelOf(c.label), [c.chat]).catch((err) => logError(`as you, ${c.name} not taken out of label ${c.label}: ${err.message}`));
        if (want) await intoLabel(want, c.chat);
        entry.set({ label: want });
      } catch (err) {
        logError(`as you, label of ${c.name}: ${err.message}`);
      }
    }
    const all = Boolean(cfg.userTags);
    if (Boolean(entry.get()?.inAll) === all) return;
    try {
      if (all) await intoLabel(ALL_LABEL, c.chat);
      else await userAuth.removeFromFeedGroup(await labelOf(ALL_LABEL), [c.chat]).catch((err) => logError(`as you, ${c.name} not taken out of label ${ALL_LABEL}: ${err.message}`));
      entry.set({ inAll: all });
    } catch (err) {
      logError(`as you, label ${ALL_LABEL} of ${c.name}: ${err.message}`);
    }
  }

  // HERDR_MUTED_SPACES says which groups are muted (all, none, or some spaces); a change
  // in config.env is applied both ways at the next start.
  async function mute(entry, space) {
    const c = entry.get();
    const want = inSpaces(cfg.muted, space);
    if (!c || Boolean(c.muted) === want) return;
    try {
      await userAuth.setMuted([c.chat], want);
      entry.set({ muted: want });
    } catch (err) {
      logError(`as you, mute ${c.chat}: ${err.message}`);
    }
  }

  return { avatar, botTags, userLabel, mute };
}
