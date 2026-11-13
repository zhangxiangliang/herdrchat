// What a chat app gives the core (lib/core/engine.mjs). Each app is a folder,
// lib/chats/<app>/, whose index.mjs exports create(ctx) returning an object with every
// member below, and `requires`: the config.env keys it cannot start without. Register it
// in lib/chats/index.mjs. `checkChat` runs at start and in the tests, so an app that
// misses one fails at once, not when a terminal first needs it.
//
// The core's words: a "room" is where one herdr-app tab is mirrored (a Feishu group, a
// Telegram topic); `k` is the core's key for a tab's terminal, stable while the room is
// that terminal's; `room` and `message` are the app's own ids, kept by the core as given.
// Markdown is the core's: **bold**, `code`, ``` blocks, > quotes, [text](url); an app
// turns it into what it can show. A `look` is {title, tone, markdown}; tone is one of
// working | closed | needs | done | good | bad.
//
// ctx: {cfg, store: {read, write}, log, logWarn, logError, stateDir,
//       lane(k, label, fn): run fn in the room's lane, scopeOf(k): its session or machine}

export const CHAT_MEMBERS = {
  name: 'string: the app, as in HERDRCHAT_CHAT',
  ready: '() -> boolean: the owner is known (no room is made before)',
  help: 'string[]: lines it adds to the direct chat\'s help',
  liveBytes: 'number: how much text one editable card holds',
  split: '(markdown) -> string[]: one message\'s worth each',
  start: '({onMessage, onAction, onReady}): connect; onMessage({room|null, where, message, text, images}) for the owner\'s messages (room null: the direct chat), onAction({value, message, answer}) -> {toast: {type, text}, card?: {kind: done|dialog, ...}} for button clicks',
  command: '(cmd, args, where) -> boolean: one of its own direct-chat commands, handled',
  openRoom: '({name, intro}) -> room',
  renameRoom: '(room, name)',
  placeRoom: '(k, {space}): what a live room looks like (tags, avatar, quiet)',
  endRoom: '(k): what a room whose terminal ended looks like',
  reviveRoom: '(k): live again',
  post: '(room, markdown) -> message',
  reply: '(where, markdown) -> message: where a message came from',
  postCard: '(room, look) -> message: an editable message',
  editCard: '(message, look)',
  postDialog: '(room, dialog, value) -> message: dialog {title, markdown, menu, doneTitle}; each button sends value plus {pick, label}',
  closeDialog: '(message, dialog, done): no buttons any more, says what was done',
  pin: '(k, room): the room waits for you',
  unpin: '(k)',
  pinned: '() -> k[]',
  ring: '(k, message, text): make the phone ring for this message if it would not',
  markWorking: '(message) -> token: your message reached the terminal',
  markDone: '(message, token): the turn that took it is over',
  image: '(buffer) -> markdown: an image to show in a post',
  download: '(message, ref, file): an image you sent, saved to file',
  tellOwner: '(look): a message in the direct chat',
  showOverview: '(rows, {fresh}): rows [{name, address, state, kind, program, since, room}]',
};

const TYPES = { name: 'string', help: 'object', liveBytes: 'number' };

// Throws, naming every member that is missing or of the wrong kind.
export function checkChat(chat) {
  const wrong = Object.keys(CHAT_MEMBERS).filter((m) => typeof chat?.[m] !== (TYPES[m] || 'function'));
  if (wrong.length) throw new Error(`chat app ${chat?.name || '?'} does not give: ${wrong.join(', ')} (lib/chats/contract.mjs)`);
  return chat;
}
