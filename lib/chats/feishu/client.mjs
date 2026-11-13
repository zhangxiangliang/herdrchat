// Feishu side: one client, markdown cards, dialog cards with buttons, one group per
// hc terminal.
import * as Lark from '@larksuiteoapi/node-sdk';

const CHUNK = 6000;

// The SDK would also print every failed request; the bot logs its own failures, with
// what it was doing, so the SDK's logger says nothing. (Its "fatal" level is 0, which the
// SDK reads as unset and turns into "info", hence a silent logger instead.)
const SILENT = { error() {}, warn() {}, info() {}, debug() {}, trace() {} };

export function createClient(cfg) {
  return new Lark.Client({ appId: cfg.appId, appSecret: cfg.appSecret, logger: SILENT, loggerLevel: Lark.LoggerLevel.error });
}

// Splits on line boundaries; a code fence cut in two is closed and reopened.
export function chunk(text, size = CHUNK) {
  const parts = [];
  let current = [];
  let length = 0;
  let fence = null;
  const flush = () => {
    if (!current.length) return;
    let body = current.join('\n');
    if (fence !== null) body += '\n```';
    parts.push(body);
    current = fence !== null ? [fence] : [];
    length = current.length ? fence.length : 0;
  };
  for (const raw of text.split('\n')) {
    for (let line = raw; ; ) {
      const piece = line.length > size ? line.slice(0, size) : line;
      if (length + piece.length + 1 > size && current.length) flush();
      current.push(piece);
      length += piece.length + 1;
      if (/^\s*```/.test(piece)) fence = fence === null ? piece.trim() : null;
      if (line.length <= size) break;
      line = line.slice(size);
    }
  }
  if (current.length) {
    parts.push(current.join('\n'));
  }
  return parts.length ? parts : [''];
}

function card(markdown) {
  return JSON.stringify({ schema: '2.0', body: { elements: [{ tag: 'markdown', content: markdown }] } });
}

// A markdown card that can be edited after it is sent (updateCard needs update_multi
// on the card both before and after).
export function textCard(markdown, title, template) {
  return { schema: '2.0', config: { update_multi: true }, header: { title: { tag: 'plain_text', content: title }, template }, body: { elements: [{ tag: 'markdown', content: markdown }] } };
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

// A markdown card per chunk; plain text when the card is refused. Returns the id of the
// last message sent.
export async function sendMarkdown(client, chatId, text) {
  let last = null;
  for (const part of chunk(text || '(empty)')) {
    try {
      last = await createMessage(client, 'chat_id', chatId, 'interactive', card(part));
    } catch (err) {
      last = await createMessage(client, 'chat_id', chatId, 'text', JSON.stringify({ text: part }));
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

// A card that asks you to pick: the screen, one button per option and, when the program
// takes your own words, a box to type them. Every button and the box send a callback
// (card.action.trigger) whose value is `value` plus {pick: <option number>, label} (or
// {pick: 'tab'} / {pick: 'esc'}); the box's text comes back as form_value.answer.
const BUTTON_TEXT = 80;

function button(text, value, type = 'default') {
  const short = text.length > BUTTON_TEXT ? `${text.slice(0, BUTTON_TEXT - 1)}…` : text;
  return { tag: 'button', type, width: 'fill', text: { tag: 'plain_text', content: short }, behaviors: [{ type: 'callback', value }] };
}

export function menuCard({ title, markdown, menu, value }) {
  const elements = [{ tag: 'markdown', content: markdown }];
  for (const o of menu.options) {
    if (o === menu.free) continue;
    const box = o.checked === null ? '' : o.checked ? '☑ ' : '☐ ';
    elements.push(button(`${o.n}. ${box}${o.label}`, { ...value, pick: o.n, label: o.label }, o.n === 1 && !menu.multi ? 'primary' : 'default'));
  }
  if (menu.multi) elements.push(button('Next ⇥', { ...value, pick: 'tab' }, 'primary'));
  if (menu.free) {
    elements.push({
      tag: 'form',
      name: 'free',
      elements: [
        { tag: 'input', name: 'answer', required: true, placeholder: { tag: 'plain_text', content: menu.free.label } },
        { ...button('Send', { ...value, pick: menu.free.n, label: menu.free.label }, 'primary'), name: 'send', form_action_type: 'submit' },
      ],
    });
  }
  elements.push(button('Esc (cancel)', { ...value, pick: 'esc' }, 'danger'));
  return { schema: '2.0', config: { update_multi: true }, header: { title: { tag: 'plain_text', content: title }, template: 'red' }, body: { elements } };
}

// The card once it is answered: the same text, no buttons, and what was done.
export function doneCard(title, markdown, done) {
  return { schema: '2.0', config: { update_multi: true }, header: { title: { tag: 'plain_text', content: title }, template: 'grey' }, body: { elements: [{ tag: 'markdown', content: `${markdown}\n\n**${done}**` }] } };
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

// A card that shows its title and opens on a tap (card JSON 2.0 collapsible_panel).
export function foldedCard(title, markdown) {
  return {
    schema: '2.0',
    body: { elements: [{ tag: 'collapsible_panel', expanded: false, header: { title: { tag: 'markdown', content: `**${title}**` } }, border: { color: 'grey', corner_radius: '5px' }, elements: [{ tag: 'markdown', content: markdown }] }] },
  };
}

// An image someone sent in a chat the bot is in, saved to `file`. Needs im:message:readonly.
export async function downloadImage(client, messageId, imageKey, file) {
  const res = await client.im.v1.messageResource.get({ path: { message_id: messageId, file_key: imageKey }, params: { type: 'image' } });
  await res.writeFile(file);
}

// What a received message says: its text and the keys of its images, in order, for
// text, image and rich text (post) messages; null for any other kind.
export function messageParts(messageType, content) {
  const c = JSON.parse(content);
  if (messageType === 'text') return { text: c.text || '', images: [] };
  if (messageType === 'image') return { text: '', images: [c.image_key] };
  if (messageType !== 'post') return null;
  const lines = [];
  const images = [];
  if (c.title) lines.push(c.title);
  for (const paragraph of c.content || []) {
    let line = '';
    for (const el of paragraph) {
      if (el.tag === 'img' && el.image_key) images.push(el.image_key);
      else if (el.tag === 'a' && el.href) line += `${el.text || ''} (${el.href})`;
      else if (typeof el.text === 'string') line += el.text; // text, code_block, md, ...
    }
    lines.push(line);
  }
  return { text: lines.join('\n').trim(), images };
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
export function startEvents(cfg, onMessage, onCardAction, onReady = () => {}) {
  const ws = new Lark.WSClient({
    appId: cfg.appId,
    appSecret: cfg.appSecret,
    loggerLevel: Lark.LoggerLevel.warn,
    onReady: () => {
      console.log('[feishu] connected');
      onReady();
    },
    onReconnecting: () => console.warn('[feishu] reconnecting'),
    onReconnected: () => console.log('[feishu] reconnected'),
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
