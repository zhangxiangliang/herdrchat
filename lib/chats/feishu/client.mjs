// Feishu side: one client and its calls (messages, cards, images, files, groups, tags,
// events). What a card holds is built in render.mjs.
import * as Lark from '@larksuiteoapi/node-sdk';
import { chunk, markdownCard } from './render.mjs';

// The SDK would also print every failed request; the bot logs its own failures, with
// what it was doing, so the SDK's logger says nothing. (Its "fatal" level is 0, which the
// SDK reads as unset and turns into "info", hence a silent logger instead.)
const SILENT = { error() {}, warn() {}, info() {}, debug() {}, trace() {} };

export function createClient(cfg) {
  return new Lark.Client({ appId: cfg.appId, appSecret: cfg.appSecret, logger: SILENT, loggerLevel: Lark.LoggerLevel.error });
}

export async function updateCard(client, messageId, cardJson) {
  const res = await client.im.v1.message.patch({ path: { message_id: messageId }, data: { content: JSON.stringify(cardJson) } });
  if (res?.code) throw new Error(`feishu message.patch ${res.code}: ${res.msg}`);
}

async function createMessage(client, receiveIdType, receiveId, msgType, content) {
  const res = await client.im.v1.message.create({
    params: { receive_id_type: receiveIdType },
    data: { receive_id: receiveId, msg_type: msgType, content },
  });
  if (res?.code) throw new Error(`feishu message.create ${res.code}: ${res.msg}`);
  return res;
}

// A markdown card per chunk, the footer under the last; plain text when the card is
// refused. Returns the id of the last message sent. `chatId` may be "open_id:<id>" for a
// person's direct chat.
export async function sendMarkdown(client, chatId, text, footer = '') {
  const [idType, id] = chatId.startsWith('open_id:') ? ['open_id', chatId.slice(8)] : ['chat_id', chatId];
  let last = null;
  const parts = chunk(text || '(empty)');
  for (const [i, part] of parts.entries()) {
    const foot = i === parts.length - 1 ? footer : '';
    try {
      last = await createMessage(client, idType, id, 'interactive', JSON.stringify(markdownCard(part, foot)));
    } catch (err) {
      last = await createMessage(client, idType, id, 'text', JSON.stringify({ text: foot ? `${part}\n\n${foot}` : part }));
      console.warn(`[feishu] card refused, sent as text: ${err.message}`);
    }
  }
  return last?.data?.message_id || null;
}

// A one-line reply that @-mentions someone. Feishu notifies a mention in a text message
// even in a muted group; a mention inside a card is not counted as one.
export async function replyMention(client, messageId, openId, text) {
  const res = await client.im.v1.message.reply({ path: { message_id: messageId }, data: { msg_type: 'text', content: JSON.stringify({ text: `<at user_id="${openId}"></at> ${text}` }) } });
  if (res?.code) throw new Error(`feishu message.reply ${res.code}: ${res.msg}`);
}

// Takes back a message the bot sent.
export async function recallMessage(client, messageId) {
  const res = await client.im.v1.message.delete({ path: { message_id: messageId } });
  if (res?.code) throw new Error(`feishu message.delete ${res.code}: ${res.msg}`);
}

export async function sendCard(client, chatId, cardJson, idType = 'chat_id') {
  return createMessage(client, idType, chatId, 'interactive', JSON.stringify(cardJson));
}

// An image for a message (shown in a card's markdown as ![image](<image_key>)) or a group
// avatar (type 'avatar'). Needs the im:resource scope.
export async function uploadImage(client, buffer, type = 'message') {
  const res = await client.im.v1.image.create({ data: { image_type: type, image: buffer } });
  const key = res?.image_key || res?.data?.image_key;
  if (!key) throw new Error(`feishu image.create: no image_key (${JSON.stringify(res).slice(0, 200)})`);
  return key;
}

// A file in a chat: uploaded (file_type "stream": any kind; at most 30 MB, never empty;
// im:resource), then sent by its key as a "file" message. Returns the message id.
export async function sendFile(client, chatId, name, buffer) {
  const up = await client.im.v1.file.create({ data: { file_type: 'stream', file_name: name, file: buffer } });
  const key = up?.file_key || up?.data?.file_key;
  if (!key) throw new Error(`feishu file.create: no file_key (${JSON.stringify(up).slice(0, 200)})`);
  const res = await createMessage(client, 'chat_id', chatId, 'file', JSON.stringify({ file_key: key }));
  return res?.data?.message_id || null;
}

// An image someone sent in a chat the bot is in, saved to `file`. Needs im:message:readonly.
export async function downloadImage(client, messageId, imageKey, file) {
  const res = await client.im.v1.messageResource.get({ path: { message_id: messageId, file_key: imageKey }, params: { type: 'image' } });
  await res.writeFile(file);
}

// One group per terminal, with you in it. You can type in it: that text goes to the terminal.
export async function createChat(client, ownerOpenId, name, description) {
  const res = await client.im.v1.chat.create({
    params: { user_id_type: 'open_id' },
    data: { name: name.slice(0, 60), description, user_id_list: [ownerOpenId], group_message_type: 'chat' },
  });
  if (res?.code) throw new Error(`feishu chat.create ${res.code}: ${res.msg}`);
  return res.data.chat_id;
}

// Group tags (enterprise custom tags): one tenant tag, bound to a group. Needs
// im:tag:write and im:biz_entity_tag_relation:write.
// Feishu refuses a tag name over 16 characters (code 407, found by trying); a longer
// one is cut at the last "-", "_" or "." that fits: build-agent-server -> build-agent.
const TAG_MAX = 16;

export function tagName(name) {
  if (name.length <= TAG_MAX) return name;
  const cut = Math.max(...['-', '_', '.'].map((c) => name.lastIndexOf(c, TAG_MAX)));
  return cut > 0 ? name.slice(0, cut) : name.slice(0, TAG_MAX);
}

export async function createTag(client, name) {
  const res = await client.im.v2.tag.create({ data: { create_tag: { tag_type: 'tenant', name: tagName(name) } } });
  if (res?.code || !res?.data?.id) throw new Error(`feishu tag.create ${res?.code}: ${res?.msg}`);
  return res.data.id;
}

// Tag calls are limited to 5 a second: they go out one at a time, TAG_GAP_MS apart, so a
// burst (every group at once) is not refused.
const TAG_GAP_MS = 250;
let tagQueue = Promise.resolve();
function queued(fn) {
  const run = tagQueue.then(fn);
  tagQueue = run.catch(() => {}).then(() => new Promise((ok) => setTimeout(ok, TAG_GAP_MS)));
  return run;
}

export function bindTag(client, tagId, chatId) {
  return queued(async () => {
    const res = await client.im.v2.bizEntityTagRelation.create({ data: { tag_biz_type: 'chat', biz_entity_id: chatId, tag_ids: [tagId] } });
    if (res?.code) throw new Error(`feishu tag bind ${res.code}: ${res.msg}`);
  });
}

export function unbindTag(client, tagId, chatId) {
  return queued(async () => {
    const res = await client.im.v2.bizEntityTagRelation.update({ data: { tag_biz_type: 'chat', biz_entity_id: chatId, tag_ids: [tagId] } });
    if (res?.code) throw new Error(`feishu tag unbind ${res.code}: ${res.msg}`);
  });
}

export async function setChatAvatar(client, chatId, imageKey) {
  const res = await client.im.v1.chat.update({ path: { chat_id: chatId }, data: { avatar: imageKey } });
  if (res?.code) throw new Error(`feishu chat.update avatar ${res.code}: ${res.msg}`);
}

export async function renameChat(client, chatId, name) {
  const res = await client.im.v1.chat.update({ path: { chat_id: chatId }, data: { name: name.slice(0, 60) } });
  if (res?.code) throw new Error(`feishu chat.update ${res.code}: ${res.msg}`);
}

// Messages in (im.message.receive_v1) and card clicks (card.action.trigger), both over
// the long connection. A click must be answered within 3 seconds; what `onCardAction`
// returns ({toast, card}) is that answer.
// onConnect runs at every connection, the first and each one after a drop; onMenu gets a
// click on the bot's menu (application.bot.menu_v6: its event_key and who clicked).
export function startEvents(cfg, onMessage, onCardAction, onReady = () => {}, onConnect = () => {}, onMenu = () => {}) {
  const ws = new Lark.WSClient({
    appId: cfg.appId,
    appSecret: cfg.appSecret,
    loggerLevel: Lark.LoggerLevel.warn,
    onReady: () => {
      console.log('[feishu] connected');
      onReady();
      onConnect();
    },
    onReconnecting: () => console.warn('[feishu] reconnecting'),
    onReconnected: () => {
      console.log('[feishu] reconnected');
      onConnect();
    },
    onError: (err) => console.error(`[feishu] connection failed: ${err.message}`),
  });
  ws.start({
    eventDispatcher: new Lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data) => {
        try {
          await onMessage(data);
        } catch (err) {
          console.error(`[feishu] message handler: ${err.stack || err.message}`);
        }
      },
      'application.bot.menu_v6': async (data) => {
        try {
          await onMenu(data);
        } catch (err) {
          console.error(`[feishu] menu handler: ${err.stack || err.message}`);
        }
      },
      'card.action.trigger': async (data) => {
        try {
          return await onCardAction(data);
        } catch (err) {
          console.error(`[feishu] card handler: ${err.stack || err.message}`);
          return { toast: { type: 'error', content: err.message.slice(0, 200) } };
        }
      },
    }),
  });
  return ws;
}
