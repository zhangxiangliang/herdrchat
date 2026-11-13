// The Telegram Bot API over plain HTTPS (core.telegram.org/bots/api): one call is
// POST https://api.telegram.org/bot<token>/<method>. Updates come by long polling
// (getUpdates), so no public URL is needed.
//
// Telegram asks for at most one message a second in one chat and answers 429 with
// retry_after when a bot goes faster, so everything that sends or edits waits its turn
// in one queue, SEND_GAP_MS apart, and a 429 waits as long as Telegram says. Reading
// calls (getUpdates, getFile) and answering a click do not wait.
const API = 'https://api.telegram.org';
const SEND_GAP_MS = 1050;
const TRIES = 4;

export class TelegramError extends Error {
  constructor(method, body) {
    super(`telegram ${method} ${body.error_code}: ${body.description}`);
    this.code = body.error_code;
    this.retryAfter = body.parameters?.retry_after;
  }
}

export function createClient(token, { log = () => {} } = {}) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function call(method, params = {}, { timeoutMs = 30000 } = {}) {
    for (let attempt = 1; ; attempt += 1) {
      const isFile = params instanceof FormData;
      const res = await fetch(`${API}/bot${token}/${method}`, {
        method: 'POST',
        headers: isFile ? {} : { 'content-type': 'application/json' },
        body: isFile ? params : JSON.stringify(params),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = await res.json().catch(() => ({ ok: false, error_code: res.status, description: res.statusText }));
      if (body.ok) return body.result;
      const err = new TelegramError(method, body);
      if (err.code === 429 && err.retryAfter && attempt < TRIES) {
        log(`telegram ${method}: too fast, waiting ${err.retryAfter} s`);
        await sleep(err.retryAfter * 1000);
        continue;
      }
      throw err;
    }
  }

  let queue = Promise.resolve();
  function queued(method, params) {
    const run = queue.then(() => call(method, params));
    queue = run.catch(() => {}).then(() => sleep(SEND_GAP_MS));
    return run;
  }

  // A photo from a buffer, as a multipart upload (at most 10 MB).
  function sendPhoto(chatId, threadId, buffer, { caption, silent = true } = {}) {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    if (threadId) form.append('message_thread_id', String(threadId));
    if (caption) form.append('caption', caption);
    form.append('disable_notification', String(silent));
    form.append('photo', new Blob([buffer]), 'image.png');
    return queued('sendPhoto', form);
  }

  // A file (sendDocument: at most 50 MB by upload), silent.
  function sendDocument(chatId, threadId, name, buffer, { caption } = {}) {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    if (threadId) form.append('message_thread_id', String(threadId));
    if (caption) form.append('caption', caption.slice(0, 1024));
    form.append('disable_notification', 'true');
    form.append('document', new Blob([buffer]), name);
    return queued('sendDocument', form);
  }

  // A file someone sent, by its file_id (bots may download up to 20 MB).
  async function download(fileId) {
    const file = await call('getFile', { file_id: fileId });
    const res = await fetch(`${API}/file/bot${token}/${file.file_path}`);
    if (!res.ok) throw new Error(`telegram file ${file.file_path}: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  return { call, queued, sendPhoto, sendDocument, download };
}
