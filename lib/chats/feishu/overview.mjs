// The overview: one card in the direct chat with the bot, as herdr-app's sidebar shows it.
// Every terminal is a line: its state, its group (a link that opens it), what it waits on
// and since when. What waits for you comes first. The card is edited in place, so it
// never rings.
const STATES = {
  blocked: { icon: '⚠️', word: 'needs you', rank: 0 },
  error: { icon: '🔴', word: 'error', rank: 1 },
  working: { icon: '⌛️', word: 'working', rank: 2 },
  done: { icon: '✅', word: 'done', rank: 3 },
  idle: { icon: '❓', word: 'idle', rank: 4 },
};
const OTHER = { icon: '❓', word: '', rank: 5 };

const chatLink = (chat) => `https://applink.feishu.cn/client/chat/open?openChatId=${chat}`;
const clock = (ms) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const escape = (text) => text.replace(/[\\`*_[\]#>~|]/g, '\\$&');

// rows: [{name, address, state, kind, program, since, room}]; state is the hc status
// word, or none. The address is what `/kill` takes.
export function overviewText(rows) {
  const sorted = [...rows].sort((a, b) => (STATES[a.state] || OTHER).rank - (STATES[b.state] || OTHER).rank || a.name.localeCompare(b.name));
  if (!sorted.length) return 'No terminal is shown in herdr-app.';
  return sorted.map((r) => {
    const s = STATES[r.state] || OTHER;
    const name = r.room ? `[${escape(r.name)}](${chatLink(r.room)})` : escape(r.name);
    const word = s === OTHER ? r.program || 'no status' : `${s.word}${r.state === 'blocked' && r.kind ? ` (${r.kind})` : ''}`;
    return `${s.icon} **${name}** · ${escape(word)}${r.since ? ` · since ${clock(r.since)}` : ''} · \`${r.address}\``;
  }).join('\n');
}

export function overviewCard(rows, now) {
  const waiting = rows.filter((r) => r.state === 'blocked').length;
  const working = rows.filter((r) => r.state === 'working').length;
  const template = waiting ? 'orange' : working ? 'blue' : 'green';
  const title = `${waiting ? `⚠️ ${waiting} needs you · ` : ''}herdrchat · ${rows.length} terminals`;
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: { title: { tag: 'plain_text', content: title }, template },
    body: { elements: [{ tag: 'markdown', content: `${overviewText(rows)}\n\n<font color='grey'>Updated ${clock(now)}</font>` }] },
  };
}
