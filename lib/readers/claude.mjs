// Reader for Claude Code (hc status app "claude-code"): its own transcript.
//   Where: the terminal's foreground pid names the session in ~/.claude/sessions/<pid>.json
//     ({sessionId, cwd}); the transcript is
//     ~/.claude/projects/<cwd with every non-alphanumeric as "-">/<sessionId>.jsonl.
//   What becomes an item:
//     you  a prompt you typed (user entry from a human), a message you sent mid-turn
//          (attachment "queued_command" from a human; the queue also carries Claude
//          Code's own task notifications, which are left out), or your answers to its
//          questions (the AskUserQuestion result's `answers`)
//     ai   the assistant's text; `end` marks the turn's last answer (stop_reason
//          "end_turn"). Some of what it says while it works is stored only as a
//          "narration" block: a thinking block whose signature names narration, holding a
//          condensed version of that text. Those count as text; plain thinking does not.
//     tool a tool it called, as one line
//     image an image you pasted (`from: 'you'`) or one a tool showed it (`from: 'ai'`:
//          a screenshot, an image file it read), as {media, data} (base64)
import { getTerminal, machineOf } from '../hc.mjs';
import { homeFile, logAfter } from '../home.mjs';
import { itemsAfter } from '../cursor.mjs';

function text(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content) || content.some((b) => b.type === 'tool_result')) return '';
  return content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

function isNarration(block) {
  if (block.type !== 'thinking' || !block.thinking?.trim() || !block.signature) return false;
  try {
    return Buffer.from(block.signature, 'base64').includes('narration');
  } catch {
    return false;
  }
}

function toolLine(block) {
  const input = block.input || {};
  const what = input.description || input.command || input.file_path || input.pattern || input.url || input.prompt || '';
  const short = String(what).replace(/\s+/g, ' ').trim();
  return `▸ ${block.name || 'tool'}${short ? `: ${short.length > 120 ? `${short.slice(0, 117)}...` : short}` : ''}`;
}

// The images in a user entry's content: ones you pasted (top-level blocks) and ones a
// tool gave the assistant to look at (inside tool results: screenshots, image files).
function images(content, human) {
  if (!Array.isArray(content)) return [];
  const out = [];
  const add = (b, from) => {
    if (b?.type === 'image' && b.source?.type === 'base64' && b.source.data) out.push({ role: 'image', from, media: b.source.media_type, data: b.source.data });
  };
  for (const b of content) {
    if (human) add(b, 'you');
    if (b.type === 'tool_result' && Array.isArray(b.content)) b.content.forEach((x) => add(x, 'ai'));
  }
  return out;
}

// The items one entry holds, in block order (an entry may hold text and tool calls).
function entryItems(entry) {
  if (entry.isSidechain) return [];
  if (entry.type === 'user' && !entry.isMeta && entry.origin?.kind === 'human') {
    const t = text(entry.message?.content).trim();
    return [...(t ? [{ role: 'you', text: t }] : []), ...images(entry.message?.content, true)];
  }
  const shown = entry.type === 'user' && !entry.isMeta ? images(entry.message?.content, false) : [];
  if (shown.length) return shown;
  const answers = entry.type === 'user' && entry.toolUseResult?.answers;
  if (answers && typeof answers === 'object') {
    const t = Object.entries(answers).map(([q, a]) => `${q} → ${a}`).join('\n').trim();
    return t ? [{ role: 'you', text: t }] : [];
  }
  const queued = entry.type === 'attachment' && entry.attachment?.type === 'queued_command' && entry.attachment;
  if (queued) {
    const t = queued.origin?.kind === 'human' ? text(queued.prompt).trim() : '';
    return t ? [{ role: 'you', text: t }] : [];
  }
  if (entry.type !== 'assistant' || !Array.isArray(entry.message?.content)) return [];
  const end = entry.message.stop_reason === 'end_turn';
  const out = [];
  for (const b of entry.message.content) {
    const said = b.type === 'text' ? b.text : isNarration(b) ? b.thinking : '';
    if (said && said.trim()) out.push({ role: 'ai', text: said.trim(), end });
    else if (b.type === 'tool_use') out.push({ role: 'tool', text: toolLine(b) });
  }
  return out;
}

export function conversationAfter(lines, cursor) {
  return itemsAfter(lines, cursor, entryItems);
}

export const app = 'claude-code';

// What is new since `cursor`: {items, file}, or null when the terminal runs no readable
// Claude. When the session moved to a new transcript (/clear, resume), what is left in
// the cursor's old file comes first.
export async function after(session, address, cursor) {
  const machine = machineOf(address);
  const pid = (await getTerminal(session, address)).foreground?.pid;
  if (!pid) return null;
  const meta = JSON.parse(await homeFile(session, machine, `.claude/sessions/${pid}.json`));
  if (!meta.sessionId || !meta.cwd) return null;
  const file = `.claude/projects/${meta.cwd.replace(/[^A-Za-z0-9]/g, '-')}/${meta.sessionId}.jsonl`;
  const items = [];
  if (cursor.file && cursor.file !== file) {
    try {
      items.push(...(await logAfter(session, machine, cursor.file, cursor, entryItems)));
    } catch {
      // the old transcript is gone; nothing left to read there
    }
  }
  items.push(...(await logAfter(session, machine, file, cursor, entryItems)));
  return { items, file };
}

// What the cursor's file still holds once the program is gone.
export function rest(session, address, cursor) {
  return logAfter(session, machineOf(address), cursor.file, cursor, entryItems);
}
