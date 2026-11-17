// What a chat app gives the core (lib/core/engine.mjs). Each app is a folder,
// lib/chats/<app>/, whose index.mjs exports create(ctx) returning an object with every
// member below, and `requires`: the config.env keys it cannot start without. Register it
// in lib/chats/index.mjs. `checkChat` runs at start and in the tests, so an app that
// misses one fails at once, not when a terminal first needs it.
//
// The core's words: a "room" is where one herdr-app tab is mirrored (a Feishu group, a
// Telegram topic); `k` is the core's key for a tab's terminal, stable while the room is
// that terminal's; `room` and `message` are the app's own ids, kept by the core as given.
// A post's body is a list of blocks (lib/chats/blocks.mjs), each shown and escaped by the
// app. Markdown is the core's: **bold**, `code`, ``` blocks, > quotes, [text](url); an app
// turns it into what it can show. A `look` is {title, tone, body, footer} (a notice of
// the bot's own has markdown for body); tone is one of
// working | closed | needs | done | good | bad. A footer (on a post, a look, a dialog) is
// where it came from, {app, model, screen, branch, context, limits}: the app shows it as
// one small line, in the words of footer() in lib/core/words.mjs (an app may import
// lib/core/words.mjs, never the engine).
//
// A call that did not get through (the network, a timeout, the service's own 5xx) throws
// an error marked `unreached: true`: the core tries it again later, and never takes it for
// a refusal (a card that cannot be edited is sent again; one that was not reached is not).
//
// ctx: {cfg, store: {read, write}, log, logWarn, logError, stateDir,
//       lane(k, label, fn): run fn in the room's lane, scopeOf(k): its session or machine,
//       claimOwner(text, key, id) -> 'ok' | 'wrong' | 'none': with no owner yet, a message
//       that may be the pairing code `herdrchat setup` shows; on 'ok' the id is written
//       to config.env as `key` and the bot starts again as that owner's}

export const CHAT_MEMBERS = {
  name: 'string: the app, as in HERDRCHAT_CHAT',
  ready: '() -> boolean: the owner is known (no room is made before)',
  help: 'string[]: lines it adds to the direct chat\'s help',
  roomWord: 'string: what the user calls a room in this app (group, topic), for what the bot says',
  liveBytes: 'number: how much one editable card holds, as bytes() counts it',
  bytes: '(body) -> number: how much a body is, as this app sends it',
  split: '(body) -> body[]: cut into bodies that each fit one card (liveBytes)',
  start: '({onMessage, onAction, onReady}): connect; onMessage({room|null, where, message, text, images}) for the owner\'s messages (room null: the direct chat), onAction({value, message, answer, ticks?}) -> {toast: {type, text}, card?: {kind: done|dialog, ...}} for button clicks; ticks: {<option n>: true|false}, a multi-select\'s boxes as ticked on the card itself (a form, sent with Next), when the app has them',
  command: '(cmd, args, where) -> boolean: one of its own direct-chat commands, handled',
  openRoom: '({name, intro}) -> room',
  renameRoom: '(room, name)',
  placeRoom: '(k, {space}): what a live room looks like (tags, avatar, quiet)',
  endRoom: '(k): what a room whose terminal ended looks like',
  reviveRoom: '(k): live again',
  post: '(room, body, {footer}) -> message: body is blocks (lib/chats/blocks.mjs) or markdown',
  reply: '(where, body) -> message: where a message came from',
  postCard: '(room, look) -> message: an editable message',
  editCard: '(message, look)',
  postDialog: '(room, dialog, value) -> message: dialog {title, markdown, menu, doneTitle}; each button sends value plus {pick, label}',
  closeDialog: '(message, dialog, done): no buttons any more, says what was done',
  pin: '(k, room, message): the room waits for you, on this message (its dialog card); an app may do nothing',
  unpin: '(k)',
  pinned: '() -> k[]',
  markWorking: '(message) -> token: your message reached the terminal',
  markDone: '(message, token): the turn that took it is over',
  image: '(buffer) -> ref: an image to show in a post, as an image block (lib/chats/blocks.mjs)',
  postFile: '(room, {name, data: Buffer, caption}) -> message: a file in the room, silent',
  postFolded: '(room, {title, markdown}) -> message: a post that shows its title and opens on a tap, silent',
  foldedBytes: 'number: how much text one folded post holds',
  download: '(message, ref, file): an image you sent, saved to file',
  tellOwner: '(look): a message in the direct chat',
  showOverview: '(rows, {fresh, ring}) -> {message, old} when it sent a new one (fresh, or the old one could not be edited), else nothing: rows [{name, address, session, state, kind, program, since, room, latest, latestAt, note?}] (latest: the first line of what it last said, at latestAt), laid out as lib/chats/overview.mjs says; note {kind: needs|done, line, at}: a note not handled yet (engine/notes.mjs), the newest one what the message says first (the lock screen); ring: the new one sounds; the old one is left as it is, for showRecord',
  showRecord: '(message, notes): an overview a newer one replaced, edited (never taken back) into the record of what it rang for: notes [{kind, name, room, line, at, handled?}], one line each as "waiting for you" has it, handled {how, at} said by words.noteHandled; none: words.OLD_OVERVIEW',
};

const TYPES = { name: 'string', help: 'object', roomWord: 'string', liveBytes: 'number', foldedBytes: 'number' };

// Throws, naming every member that is missing or of the wrong kind.
export function checkChat(chat) {
  const wrong = Object.keys(CHAT_MEMBERS).filter((m) => typeof chat?.[m] !== (TYPES[m] || 'function'));
  if (wrong.length) throw new Error(`chat app ${chat?.name || '?'} does not give: ${wrong.join(', ')} (lib/chats/contract.mjs)`);
  return chat;
}
