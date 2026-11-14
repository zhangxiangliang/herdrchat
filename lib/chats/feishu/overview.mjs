// The overview: one card in the direct chat with the bot, as herdr-app's sidebar shows it.
// Every terminal is a line: its state as a colored tag, its group (a link that opens it),
// what it waits on and since when. What waits for you
// comes first. The card is edited in place, so it never rings.
import { header } from './client.mjs';

const STATES = {
  blocked: { color: 'orange', word: 'needs you', rank: 0 },
  error: { color: 'red', word: 'error', rank: 1 },
  working: { color: 'blue', word: 'working', rank: 2 },
  done: { color: 'green', word: 'done', rank: 3 },
  idle: { color: 'neutral', word: 'idle', rank: 4 },
};
const OTHER = { color: 'neutral', word: '', rank: 5 };

const chatLink = (chat) => `https://applink.feishu.cn/client/chat/open?openChatId=${chat}`;
const clock = (ms) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
// Feishu keeps a backslash escape inside link text, so marks are written as HTML
// entities, which it reads everywhere in markdown. A text_tag is not markdown: it shows
// its text as it is, entities and backslashes too, so only what would end the tag goes.
const escape = (text) => text.replace(/[\\`*_[\]#>~|<&]/g, (c) => `&#${c.charCodeAt(0)};`);
const tagText = (text) => text.replace(/[<>]/g, '');

// rows: [{name, address, state, kind, program, since, room}]; state is the hc status
// word, or none. The address is what `/kill` takes.
export function overviewText(rows) {
  const sorted = [...rows].sort((a, b) => (STATES[a.state] || OTHER).rank - (STATES[b.state] || OTHER).rank || a.name.localeCompare(b.name));
  if (!sorted.length) return 'No terminal is shown in herdr-app.';
  return sorted.map((r) => {
    const s = STATES[r.state] || OTHER;
    const name = r.room ? `[${escape(r.name)}](${chatLink(r.room)})` : escape(r.name);
    const word = s === OTHER ? r.program || 'no status' : `${s.word}${r.state === 'blocked' && r.kind ? ` (${r.kind})` : ''}`;
    return `<text_tag color='${s.color}'>${tagText(word)}</text_tag> **${name}**${r.since ? ` · since ${clock(r.since)}` : ''} · \`${r.address}\``;
  }).join('\n');
}

export function overviewCard(rows, now) {
  const waiting = rows.filter((r) => r.state === 'blocked').length;
  const working = rows.filter((r) => r.state === 'working').length;
  const tone = waiting ? 'needs' : working ? 'working' : 'good';
  const title = `${waiting ? `${waiting} needs you · ` : ''}herdrchat · ${rows.length} terminals`;
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: header(title, tone),
    body: { elements: [{ tag: 'markdown', content: overviewText(rows) }, { tag: 'markdown', content: `Updated ${clock(now)}`, text_size: 'notation' }] },
  };
}
