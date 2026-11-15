// Every word the bot says in the chat, in one place: titles, notes, replies, toasts,
// buttons and notices, from the core, the bot and each chat app (what only one app says,
// such as Feishu's /auth, is marked so). They add the marks (bold, quotes, code blocks)
// themselves. Something quoted back (a label, an error, a name) comes in as an argument,
// as it is.
import { percent, tokens } from './meter.mjs';

// ---------- titles ----------

export const NEEDS = '⚠️ Needs you';
export const needs = (kind) => `${NEEDS}${kind ? ` (${kind})` : ''}`;
export const TO_START = 'to start'; // the kind of what an agent asks before it starts
export const DONE = '✅ Done';
export const LIVE = '⌛️ Working…';
export const FULL = '⌛️ Working… (continued below)'; // a full card while the turn goes on
export const CLOSED = '✅ Worked'; // the turn is over
export const beforeRoom = (shown, total, inFile) => `📜 Before this room${shown < total ? ` (the last ${shown} of ${total}${inFile ? '; all of it is in the file' : ''})` : ''}`;

// ---------- a post's footer: where it came from ----------

// {app, model, screen, branch, context: {used, size}, limits: [{name, used}]} ->
// "claude · claude-opus-5-5 · main · context 23% (234k) · 5-hour 2% · 7-day 57%"; read off
// the screen, "screen" stands where the model would. What is not known is left out; with
// nothing known, no footer ('').
export function footer({ app, model, screen, branch, context, limits } = {}) {
  const parts = [app, screen ? 'screen' : model, branch];
  if (context?.used) parts.push(context.size ? `context ${percent(context.used / context.size)} (${tokens(context.used)})` : `context ${tokens(context.used)}`);
  for (const l of limits || []) if (Number.isFinite(l.used)) parts.push(`${l.name} ${Math.round(l.used)}%`);
  return parts.filter(Boolean).join(' · ');
}

// ---------- rings: the short reply that makes the phone sound ----------

export const RING_NEEDS = '⚠️ needs you';
export const RING_DONE = '✅ done';

// ---------- a room and what is posted in it ----------

export const roomIntro = (address, session) => `hc terminal ${address} (hc session "${session}"). Type here to talk to it.`;
export const YOU = 'You';
export const from = (name) => `From ${name}`;
export const answerTo = (whom) => `answer: ${whom}`;
export const image = (fromYou) => `an image ${fromYou ? 'you pasted' : 'it looked at'}`;
export const imageNotSent = (fromYou, why) => `${image(fromYou)} was not sent: ${why}`;
export const BLANK = '(blank)';
export const TERMINAL_ENDED = 'Terminal ended';
export const newTerminalHere = (address) => `↪ This tab runs a new terminal now (${address}); it carries on here.`;
export const INPUT_EMPTIED = 'It did not take this, so its input box was emptied.';
export const ANSWER_HOW = 'Reply `/answer <text>` to answer it, or `/esc` to cancel it.';
export const WAITS_ON_DIALOG = `It waits on a dialog. ${ANSWER_HOW}`;
export const stopped = (why) => `It stopped: ${why}`; // a turn that ended on an error, with no answer

// the conversation before a room, as a file
export const oldestLeftOut = (mb) => `the oldest part is left out: the whole is over ${mb} MB`;
export const transcriptHead = ({ address, session, first, last, count }) => `hc terminal ${address} (hc session "${session}"), ${first} to ${last} UTC, ${count} items.`;
export const transcriptCaption = (count) => `The conversation before this room: ${count} items`;

// ---------- a dialog card: its buttons, what was done, and the toast for a tap ----------

export const NEXT_BUTTON = 'Next ⇥';
export const ESC_BUTTON = 'Esc (cancel)';
export const SEND_BUTTON = 'Send';
export const orTypeHere = (label) => `Or type your answer here (${label}).`; // Telegram: its own words go in the topic

export const picked = (what) => `✔ ${what}`;
export const ANSWERED = picked('Answered.');
export const CANCELLED_DONE = 'Cancelled.';
export const MOVED_ON = 'It moved on; see the next card.';
export const ENDED_DONE = 'The terminal has ended.';
export const NO_LONGER_WAITS = 'It no longer waits on this.';
export const CHANGED_BEFORE_TAP = 'It changed before your tap, so nothing was pressed. The card shows it now: tap again.';
export const ASKS_ELSE = 'It asks something else now, so nothing was answered. The card shows it: tap again.';
export const OPTIONS_CHANGED_PRESSED = 'The options changed; nothing was pressed.';
export const OPTIONS_CHANGED_ANSWERED = 'The options changed; nothing was answered.';
export const TYPE_FIRST = 'Type your answer first.';
export const notTaken = (app) => `${app} did not take it; nothing changed. Tap again, or answer in herdr-app.`;
export const toggled = (wasTicked, label) => `${wasTicked ? '☐' : '☑'} ${label}`;
// what a tap picked, besides an option's own label
export const NOTHING_TICKED = 'nothing ticked';
export const ESC_PRESSED = 'Esc pressed';
export const NEXT = 'Next';
export const CANCELLED = 'Cancelled';

// ---------- the overview: every terminal ----------

export const overviewTitle = (waiting, count) => `${waiting ? `${waiting} needs you · ` : ''}herdrchat · ${count} terminals`;
export const NO_TERMINALS = 'No terminal is shown in herdr-app.';
const STATE_WORDS = { blocked: 'needs you', error: 'error', working: 'working', done: 'done', idle: 'idle' };
// a terminal's state, by its hc status word; with none (no agent), the program it runs
export const stateWord = ({ state, kind, program }) => (STATE_WORDS[state] ? `${STATE_WORDS[state]}${state === 'blocked' && kind ? ` (${kind})` : ''}` : program || 'no status');
export const since = (clock) => `since ${clock}`;
export const updatedAt = (clock) => `Updated ${clock}`;

// ---------- replies to what you send ----------

export const notDelivered = (why) => `Not delivered: ${why}`;
export const ENDED_REPLY = notDelivered('this terminal has ended. Nothing you send here reaches it.');
export const NO_CONVERSATION = 'No agent runs here, so there is no conversation to show.';
export const ESC_PRESSED_SCREEN = 'Esc pressed.';
export const ASKS_FIRST = 'It asks something first (the card above). Your message goes in once that is answered.';
export const ASKS_FIRST_IN_APP = 'It asks something first, in herdr-app (its card could not be posted here). Your message goes in once that is answered.';
export const imagesInRoom = (roomWord) => `Send images in a terminal's ${roomWord}.`;
export const couldNotHandle = (why) => `⚠️ Not delivered: it could not be handled (${why}). Send it again; \`herdrchat logs\` has the details.`;
export const notPassedOn = (type) => notDelivered(`only text and images are passed on, not this (${type}). Copy its text into a message.`); // Feishu
export const ONLY_OWNER = 'Only the owner can answer.';
export const NO_TICKS = 'No ticked box came through, so nothing was sent. Tick at least one, or answer it in herdr-app.'; // Feishu's form
export const CARD_TOO_OLD = 'This card is too old to answer; see the newest card.'; // Telegram
export const DIALOG_GONE = 'This dialog is gone.'; // Telegram
export const notARoom = (roomWord) => notDelivered(`this ${roomWord} is not a terminal's. Each terminal has its own ${roomWord}; the direct chat takes /ls, /new and /kill.`);

// ---------- the direct chat ----------

// a herdrchat command as this profile runs it
const withProfile = (command, profile) => `${command}${profile && profile !== 'default' ? ` --profile ${profile}` : ''}`;
// pairing: the first message to a bot with no owner
export const paired = (roomWord, more = '') => `✅ Paired: you are this bot's owner now. It starts again, and your terminals' ${roomWord}s appear in a moment.\n\nThen: type in a terminal's ${roomWord} to talk to it; here, /ls shows them all, /new starts one${more}.`;
export const PAIRED_AUTH = ', /auth lets the bot mute its groups'; // Feishu
export const NOT_THE_CODE = 'That is not the code. Send the 6 digits `herdrchat setup` shows.';
export const noOwner = ({ profile, configFile, line }) => `Hello! This bot has no owner yet. Run \`${withProfile('herdrchat setup', profile)}\` and send me the code it shows; or add this line to ${configFile || 'config.env'} yourself and run \`${withProfile('herdrchat start', profile)}\`:\n\n\`${line}\``;
// Telegram's command menu (setMyCommands)
export const COMMANDS = [
  { command: 'ls', description: 'a new overview of every terminal' },
  { command: 'new', description: '<session> <space>/<tab> [command]: start a terminal' },
  { command: 'kill', description: '<session> <address>: end a terminal' },
  { command: 'screen', description: 'in a topic: its terminal\'s screen' },
  { command: 'answer', description: 'in a topic: <text> answers what it waits on' },
  { command: 'esc', description: 'in a topic: press Esc' },
  { command: 'history', description: 'in a topic: the conversation so far, as a file' },
];
// Feishu's /auth: the bot acting as you
export const AUTH_HELP = '`/auth` let the bot act as you for chat-list settings (mute, labels, pin)';
export const authLink = (code, url) => `Open this link and allow it (the code is ${code}):\n\n${url}\n\nIt lets the bot mute its groups for you, put them in your labels and pin the one that needs you. Nothing else.`;
export const allowed = (refresh) => `✅ Allowed${refresh ? '' : ' (no refresh token: it lasts about two hours)'}. Muting the groups and putting them in your labels now.`;
export const notAllowed = (why) => `Not allowed: ${why}`;
export const notYouAnyMore = () => ({ title: NEEDS, tone: 'needs', markdown: 'The bot can no longer act as you (mute, labels, pin). Send `/auth` to allow it again.' });

export const help = (appLines, roomWord) => [
  '`/ls` a new overview of every terminal (the overview also keeps itself up to date)',
  '`/new <session> <space>/<tab> [command]` start a terminal (default `claude`); `--cwd <dir>` first to pick its folder',
  '`/kill <session> <address>` end a terminal',
  ...appLines,
  `In a terminal's ${roomWord}: type to talk to it; \`/screen\`, \`/answer <text>\`, \`/esc\`, \`/history\` (the conversation so far, as a file).`,
].join('\n');
export const started = ({ line, address, session, space, tab, folder, roomWord }) => `Started \`${line}\` as \`${address}\` in ${session} / ${space} / ${tab} (\`${folder}\`). Its ${roomWord} appears in a moment.`;
export const killed = (address, session) => `Ended \`${address}\` in ${session}.`;
export const unknownSession = (session, known) => `unknown session "${session}"; known: ${known.join(', ')}`;
export const GIVE_PLACE = 'give the place as <space>/<tab>';
export const GIVE_KILL = 'give `/kill <session> <address>`';

// ---------- the bot itself: down, back, updates ----------

export const down = (why) => ({ title: '🔴 herdrchat is down', tone: 'bad', markdown: `herdrchat stopped: ${why}\n\nIt is being started again. Until it is back, nothing you send here reaches your terminals.` });
export const back = (minutes, why) => ({ title: '✅ herdrchat is back', tone: 'good', markdown: `herdrchat is back after about ${minutes} min. What stopped it: ${why}` });
export const updated = (now, was, notes) => ({ title: '✅ herdrchat updated', tone: 'good', markdown: `herdrchat is now ${now} (was ${was}). What changed: ${notes}` });
export const needsRestart = (installed, runs) => ({ title: '⚠️ herdrchat needs a restart', tone: 'needs', markdown: `herdrchat ${installed} is installed, but this bot still runs ${runs}, and it was started by hand, so nothing starts it again if it stops. Restart it: \`herdrchat start\` (or stop \`herdrchat run\` and run it again).` });
export const offer = (latest, runs, notes) => ({
  title: `⬆️ herdrchat ${latest} is out`,
  tone: 'working',
  markdown: `You run ${runs}. What changed: ${notes}\n\nThe button installs it with npm (with its skill and hook). Then every herdrchat bot on this machine starts again on it by itself: a few seconds without the bot. To go back, in a terminal: \`herdrchat update ${runs}\``,
  button: `Update to ${latest}`,
});
export const ALREADY_UPDATING = 'Already updating.';
export const updating = (version) => `Updating to ${version}…`;
export const updatingCard = (version, from) => ({ dialog: { doneTitle: `⬆️ herdrchat ${version}`, markdown: `Updating from ${from}.` }, done: 'Updating: the result comes as a new message.' });
export const UPDATED_RESTARTS = 'This bot starts again on it in a moment, and says so when it is back.';
export const installed = (ok, version, lines) => ({ title: ok ? `✅ herdrchat ${version} installed` : '🔴 herdrchat was not updated', tone: ok ? 'good' : 'bad', markdown: lines });
