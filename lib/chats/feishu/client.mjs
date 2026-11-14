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

function card(markdown, footer) {
  return JSON.stringify({ schema: '2.0', body: { elements: [{ tag: 'markdown', content: markdown }, ...footerElements(footer)] } });
}

// A post's footer (where it came from): one small grey line under it. Its marks are HTML
// entities, which Feishu reads in markdown (a backslash escape it would show).
export function footerElements(footer) {
  return footer ? [{ tag: 'markdown', content: footer.replace(/[\\`*_[\]#>~|<&]/g, (c) => `&#${c.charCodeAt(0)};`), text_size: 'notation' }] : [];
}

// A card's header: its title with Feishu's own icon for what the card is, in place of the
// emoji the core leads a title with (the icon says it once), and the color of its tone.
export const TONES = {
  working: { template: 'blue', icon: 'loading_outlined' },
  closed: { template: 'grey', icon: 'done_outlined' },
  needs: { template: 'orange', icon: 'warning_outlined' },
  done: { template: 'grey', icon: 'done_outlined' },
  good: { template: 'green', icon: 'done_outlined' },
  bad: { template: 'red', icon: 'warning_outlined' },
};
const LEADING_EMOJI = /^(?:[\p{Extended_Pictographic}\u2600-\u27BF][\uFE0F\u200D]*\s*)+/u;
export function header(title, tone) {
  const t = TONES[tone] || TONES.working;
  return { title: { tag: 'plain_text', content: String(title).replace(LEADING_EMOJI, '') || String(title) }, template: t.template, icon: { tag: 'standard_icon', token: t.icon, color: t.template } };
}

// A markdown card that can be edited after it is sent (updateCard needs update_multi
// on the card both before and after).
export function textCard(markdown, title, tone = 'working', footer = '') {
  return { schema: '2.0', config: { update_multi: true }, header: header(title, tone), body: { elements: [{ tag: 'markdown', content: markdown }, ...footerElements(footer)] } };
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
      last = await createMessage(client, idType, id, 'interactive', card(part, foot));
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

// A card that asks you to pick: the screen, one button per option and, when the program
// takes your own words, a box to type them. Every button and the box send a callback
// (card.action.trigger) whose value is `value` plus {pick: <option number>, label} (or
// {pick: 'tab'} / {pick: 'esc'}); the box's text comes back as form_value.answer.
const BUTTON_TEXT = 80;

function button(text, value, type = 'default') {
  const short = text.length > BUTTON_TEXT ? `${text.slice(0, BUTTON_TEXT - 1)}…` : text;
  return { tag: 'button', type, width: 'default', size: 'medium', text: { tag: 'plain_text', content: short }, hover_tips: { tag: 'plain_text', content: text }, behaviors: [{ type: 'callback', value }] };
}

// Buttons side by side, wrapping onto the next line when the screen is narrow.
const row = (buttons) => ({ tag: 'column_set', flex_mode: 'flow', horizontal_spacing: 'small', columns: buttons.map((b) => ({ tag: 'column', width: 'auto', elements: [b] })) });
// Short options (Yes / No) sit side by side; a long one would be cut there, so then each
// option is a line of its own, as wide as its words, at the left like the text above.
const SIDE_BY_SIDE = { most: 4, chars: 14 };
const fitsSideBySide = (labels) => labels.length <= SIDE_BY_SIDE.most && labels.every((l) => [...l].length <= SIDE_BY_SIDE.chars);
const options = (buttons, labels) => (fitsSideBySide(labels) ? [row(buttons)] : buttons);

// A multi-select's boxes are checkers in a form: with no behaviors a checker is ticked on
// the phone only, so ticking makes no call and shows no loading; Next submits the form,
// and each box comes back in form_value under its name, box_<n> (ticksOf reads them).
export const BOX = 'box_';
export function menuCard({ title, markdown, menu, value, footer = '' }) {
  const elements = [{ tag: 'markdown', content: markdown }];
  const boxes = [];
  const choices = [];
  for (const o of menu.options) {
    if (o === menu.free) continue;
    if (menu.multi && o.checked !== null) {
      boxes.push({ tag: 'checker', name: `${BOX}${o.n}`, checked: o.checked, text: { tag: 'plain_text', content: `${o.n}. ${o.label}` } });
      continue;
    }
    choices.push(button(`${o.n}. ${o.label}`, { ...value, pick: o.n, label: o.label }, o.n === 1 && !menu.multi ? 'primary_filled' : 'default'));
  }
  if (choices.length) elements.push(...options(choices, choices.map((b) => b.text.content)));
  if (menu.multi) {
    elements.push({ tag: 'form', name: 'boxes', elements: [...boxes, { ...button('Next ⇥', { ...value, pick: 'tab' }, 'primary_filled'), name: 'next', form_action_type: 'submit' }] });
  }
  if (menu.free) {
    elements.push({
      tag: 'form',
      name: 'free',
      elements: [
        { tag: 'input', name: 'answer', required: true, placeholder: { tag: 'plain_text', content: menu.free.label } },
        { ...button('Send', { ...value, pick: menu.free.n, label: menu.free.label }, 'primary_filled'), name: 'send', form_action_type: 'submit' },
      ],
    });
  }
  elements.push(row([button('Esc (cancel)', { ...value, pick: 'esc' }, 'danger_text')]), ...footerElements(footer));
  return { schema: '2.0', config: { update_multi: true }, header: header(title, 'needs'), body: { elements } };
}

// The card once it is answered: the same text, no buttons, and what was done.
// A dialog once answered (or gone): grey, its text, and what was done in small type.
export function doneCard(title, markdown, done, footer = '') {
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: header(title, 'done'),
    // the icon is the check: one the core leads `done` with goes
    body: { elements: [{ tag: 'markdown', content: markdown }, { tag: 'markdown', content: String(done).replace(/^[✔✓]\uFE0F?\s*/u, ''), text_size: 'notation', icon: { tag: 'standard_icon', token: 'done_outlined', color: 'grey' } }, ...footerElements(footer)] },
  };
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
// null for what is not passed on: another type (a file, forwarded chat records, ...), or a
// content that is not JSON (a merged forward lists as "Merged and Forwarded Message").
export function messageParts(messageType, content) {
  let c;
  try {
    c = JSON.parse(content);
  } catch {
    return null;
  }
  if (!c || typeof c !== 'object') return null;
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

// The boxes as ticked, from a submitted form: {<n>: true|false}, or null when form_value
// has none of them (then nothing can be known, and nothing should be pressed). A checker's
// value is read as true when it is true or "true".
export function ticksOf(formValue) {
  const entries = Object.entries(formValue || {}).filter(([name]) => name.startsWith(BOX));
  if (!entries.length) return null;
  return Object.fromEntries(entries.map(([name, v]) => [Number(name.slice(BOX.length)), v === true || v === 'true']));
}
