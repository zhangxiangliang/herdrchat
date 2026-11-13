# herdrchat guide

How herdrchat works and every setting, for when the README is not enough.

herdrchat is a chat front-end for hc: every herdr-app tab, followed and answered in a chat
app, Feishu or Telegram. Both sit on the same core (hc events, a reader per agent,
dialogs, the overview), each behind one contract (`docs/architecture.md`); Slack and
Discord may follow the same way. A profile is one chat app (`HERDRCHAT_CHAT`); to use
both, run a profile each.

## Feishu

herdr-app, moved into one Feishu bot:

| herdr-app | Feishu |
|---|---|
| a terminal it shows (it has a `where` label) | a group named `<space> / <tab>`, tagged with the session; type there to talk to it. A tab only numbered (`2`) is named by the terminal's title instead (whatever the program sets, for any agent; Claude Code sets its session name or topic), else its hc name |
| a space | one avatar for all of its groups: the space's first letter on a color of its own |
| a terminal on another machine | a group named `<space> / <tab>`, tagged with the machine, made once |
| a terminal that is gone | its group stays, with its history, tagged `ended` (untagged if it comes back) |
| herdr itself | the direct chat with the bot: an overview card (every terminal's state, what waits for you first, each a link to its group), kept up to date in place; `/ls`, `/new`, `/kill` |

Everything comes from hc, so it works the same for Claude Code, codex, pi or any program
hc shows, on this machine or on a machine hc has added. Nothing is installed in the agents.

## Telegram

A Telegram bot cannot make groups, so it uses topics in your private chat with the bot
(topic mode must be on in @BotFather):

| herdr-app | Telegram |
|---|---|
| a tab | a topic named `<space> / <tab>` in the bot's private chat; type there to talk to it |
| a space | one topic icon color for all of its topics (Telegram offers six) |
| a terminal that is gone | its topic stays, its name starting with 🔚 (taken off if it comes back) |
| herdr itself | the chat's main thread: the overview message, edited in place; `/ls`, `/new`, `/kill`; `/` shows the commands |

What differs: an image goes as its own photo after the text (a message cannot hold one);
a dialog's free answer is typed in the topic (a message has no text box); there are no
tags, labels, pins or `/auth` (a bot cannot act as you). Telegram takes about one message
a second in a chat, so the bot queues and waits as Telegram asks. Setting it up:
`skills/herdrchat/references/telegram.md`.

## How it works: hc, plus a reader per agent

**hc is the backbone.** The bot follows `hc events --json` for each session (format:
herdr-core `schema/README.md`, "Events"). From hc it learns which terminals exist, where
herdr-app shows them, their status, and when a turn ends (`turn` event: the status left
`working`). Typing from a group goes through `hc send`.

**A reader gives the conversation.** hc can show only the screen, and the screen is a
picture: long output is folded, and you cannot tell your words from the agent's. So for
each agent a reader reads the agent's own records. The status hc reports names the agent
(`status.app`), and that name picks the reader (`lib/core/readers/`):

| `status.app` | reader | reads |
|---|---|---|
| `claude-code` | `lib/core/readers/claude.mjs` | its transcript: the terminal's foreground pid names the session in `~/.claude/sessions/<pid>.json` |
| anything else | none | nothing by itself; what you type gets its screen in reply |

On another machine, a reader reads the same files through `hc exec --on`. To add an
agent: `docs/architecture.md`, "Adding a harness".

## What a room shows

A room is a Feishu group or a Telegram topic.

- A program with a reader:
  - while it works: one "⌛️ Working…" card per turn (then "✅ Worked"), edited every 5
    seconds with what is new: what it says, your prompts (typed in the terminal or sent
    mid-turn) as **You:**, and each tool it calls as one line (`▸ Bash: Run the tests`).
    It shows the program is alive, as herdr-app does, and since an edit is not a new
    message, the phone does not ring every few seconds;
  - when the turn ends: its last answer, as a new message. In a space of
    `HERDR_MUTED_SPACES` (all, by default) only "needs you" and "done" ring: in Feishu
    the groups are muted (after `/auth`) and an @ under the answer rings; in Telegram
    the posts go silently and a short reply rings. `HERDR_SILENT_SPACES` rings nothing.
  - A message another terminal sent with `hc send` shows as **From t7 review**, not as
    yours (hc wraps it in `<hc from="…">`, for any agent).
  - Images too: ones it looked at (a screenshot, an image file it read) and ones you
    pasted in the terminal, shown in the card.
  - What you sent from the group is not repeated.
- Anything else (a shell, a tool, an agent that has quit): nothing by itself. A terminal
  counts as an agent only while its foreground process is that agent, so a status left
  over after it quits posts nothing.
- A turn that ends on `blocked` (permission, question, auth): what it said first, then
  a red "⚠️ Needs you" card. When the screen shows a numbered menu (as Claude Code's
  permission and question dialogs do), the card shows only the dialog, as text, with a
  button per option; a multi-select also has "Next ⇥", a "Type something" option a box to
  type in (Feishu; in Telegram you type the answer in the topic), and every card "Esc".
  Without a menu the card shows the last lines of the screen and how to answer by typing.
  Once the dialog is gone the card turns to "✅ Done". A card is posted only for a dialog
  that still waits: one answered while its screen was read gets none.

## Answering a dialog from the chat

A button presses that option's number key in the terminal (Esc presses esc). A question
with previews (a box beside its options) takes no number, so there the button moves with
the arrows from the cursor to that option and presses Enter. In a multi-select, a box is
ticked on the card only, at once; Next sends them all: each box that differs from the
screen is pressed, then tab.
Before it presses anything, the bot reads the screen again and checks that it still
shows the same dialog (a hash of it, from its top border to its last option, without the
cursor, the check marks and the preview box) and the same option, so an old card can never answer a newer dialog that looks alike. After the
key, the card turns into the dialog's next step (a toggled box, the next question, the
review) or says what was picked. Text you type in the group while it waits goes into its
"Type something" box when it has one.

A dialog answered in the terminal (or left for the next one) closes its card: the
buttons go and the card says so. The screen is read the moment `blocked` arrives, so a
dialog answered in the terminal at once still gets its card; and since hc sends a turn
event only when a program leaves `working`, status events catch a program that goes
from one dialog straight to the next. One dialog gets one card.

## Nothing is lost

- What was posted is remembered per terminal in `state.json` (entry ids, not only a
  time), so a restart picks up where it stopped, entries with the same timestamp or
  written late are still posted, and nothing is posted twice.
- A post that fails is retried (2, 4, 8, 16 s); if it still fails the cursor stays, and the
  content goes out with the next post. A repeat is acceptable, a loss is not.
- The "⌛️ Working…" card holds everything, not a status line. A full card (20 KB) is closed
  and the next one goes on; a card that cannot be edited is sent again as a new one. Which
  card is open is kept in `state.json`, so a restart goes on editing it. While it
  works, the turn's last answer is left for the turn's end, so it always arrives as its
  own message.
- After a turn ends the bot waits for the agent's last answer (for Claude,
  `stop_reason: end_turn`); hc reports the end before the agent writes it.
- Idle terminals with a reader are checked again at start, after every event snapshot and
  every minute, so a missed event or a late write is caught up.
- When a Claude session moves to a new transcript (`/clear`, resume), what is left in the
  old one is posted first; when a terminal ends, what its log still holds is posted first.
- Some of what Claude says while it works is stored only as a "narration" block (a thinking
  block whose signature names narration); it is posted too. It holds a condensed version of
  the text shown on screen, the only version on disk.

On the first start the bot posts only what happens from then on, never older history.
A new room is not empty: it gets the conversation before it, all of it as a `.md` file
and its newest part in one folded post, silent and never repeated (`HERDR_HISTORY` says
which: `file,folded` by default, `file`, `folded`, or empty for neither). `/history` in a
room posts both again.

In a terminal that runs no agent, what you type gets one reply: its screen a moment
later, without blank lines.

A group belongs to its herdr-app tab (by the tab's id): when the tab's terminal is
replaced, the new terminal carries on in the same group. A message that cannot be
delivered (the terminal has ended) says so plainly.

## Commands

- Direct chat: `/ls` (the overview again at the bottom of the chat; the old one is
  recalled), `/new <session> <space>/<tab> [command]` (start one; default `claude`;
  `--cwd <dir>` first to pick its folder), `/kill <session> <address>`, `/auth` (see
  below).
- In a terminal's room: any text goes to it (marked once typed in, and again when the
  turn that took it is over); an image (alone or in a rich text message) is sent
  beside the terminal with `hc put`, on its machine, and its path is typed in with your
  text, so an agent like Claude Code opens it; `/screen`, `/answer <text>` (type into the
  dialog it waits on, as is), `/esc`, `/history` (the conversation so far, as a file and
  a folded post). Dialog cards have buttons.

## Set up

Telegram: `skills/herdrchat/references/telegram.md`. Feishu:

Steps 1, 2, 5 and 6 are in the Feishu developer console; the herdrchat skill
(`/herdrchat setup`, see "Skills") does them with an agent, or guides you through them.

1. Feishu developer console: create a custom app (企业自建应用), add the bot ability.
2. Permissions (batch import): `im:message:send_as_bot`, `im:message.p2p_msg:readonly`,
   `im:message.group_msg`, `im:chat:create`, `im:chat:update`,
   `im:message.reactions:write_only`, `im:resource` (images out),
   `im:message:readonly` (images in), `im:tag:write`,
   `im:biz_entity_tag_relation:write` (group tags).
3. `herdrchat init` makes `~/.config/herdrchat/default/config.env`; fill the app ID, the
   secret and `HERDR_SESSIONS`: the hc sessions on the machine the bot runs on that herdr-app shows
   (the machines they connect to come along, as in herdr-app). See "Where things are"
   for other places and more than one profile.
4. `herdrchat start` (the console checks for a live connection in the next step).
5. Events and callbacks (事件与回调): for events, choose the long connection mode (长连接)
   and add `im.message.receive_v1`; for callbacks (回调配置), choose the long connection
   mode too and add `card.action.trigger` (the dialog buttons).
6. Publish a version.
7. Open `https://applink.feishu.cn/client/bot/open?appId=<app id>` and send anything.
   The bot answers with your `open_id`; put it in `FEISHU_OWNER_OPEN_ID` and run
   `herdrchat start` again.
8. Once it works: `herdrchat install` (see "Running as a service").

## Running as a service

`herdrchat start` runs the bot in an hc terminal, which ends when that hc core stops,
and nothing starts it after a reboot. `herdrchat install` makes it a service of the
system instead: a launchd agent on macOS, a systemd user unit on Linux. It starts at
login, comes back by itself after a crash, and does not depend on any hc core. It runs
node and the bot by their full paths with only the variables it needs (hc's path, PATH,
the profile, the folders), so no agent's variables come along. With it installed,
`start`, `stop` and `status` go through the service; `herdrchat uninstall` removes it.
Each profile is its own service (`herdrchat install --profile telegram`).

- After a node upgrade that moves node, run `herdrchat install` again; `herdrchat status`
  says when the service's node is gone.
- On Linux, `loginctl enable-linger` keeps it running after you log out.
- What the process prints before its log is open (a crash at start) goes to
  `logs/service.out.log` in the state folder.

## Optional: let the bot act as you

Some chat-list settings only you can change. Send `/auth` in the direct chat and allow it
on Feishu's page (OAuth device flow: a link and a code, no public address needed); the
token is refreshed on its own and kept in `user-token.json` in the state folder (mode 600).
Then:

- groups are muted (`HERDR_MUTED_SPACES` in `config.env`: `all`, the default; empty for none; or
  some spaces, comma-separated; a change applies both ways at the next start), and in a
  muted group a one-line reply that @-mentions you goes under each card that needs you and
  under each turn's last answer, unless its space is in `HERDR_SILENT_SPACES` (empty by
  default; same values) to stay fully quiet: in a muted group only a mention rings (a
  mention inside a card does not count as one), so the phone rings only then;
- each group is also in one of your own labels (the session or machine; `ended` once
  the terminal is gone), to filter the chat list by; the bot tags stay, since only they
  show next to a group's name. Either can be turned off: `HERDR_USER_TAGS=off` takes the
  groups out of your labels (the labels stay), `HERDR_BOT_TAGS=off` takes the bot's tags
  off (they are tenant tags, visible to the whole tenant);
- the group that needs you is pinned until it no longer does.

The app needs these user scopes: `im:chat.user_setting:write`, `im:feed_group_v1:read`,
`im:feed_group_v1:write`, `im:feed.shortcut:write`, `offline_access`. Without `/auth`
none of this happens and everything else works the same. If the token can no longer be
refreshed, the bot says so once and falls back.

## Skills

`skills/herdrchat/` is one skill for an agent (Claude Code or another that reads
`SKILL.md`): `/herdrchat setup`, `status`, `start`, `stop`, `install`, `logs`, `auth`,
`config`, `fix`, `feishu <task>` (the developer console, with Ego Lite from
https://lite.ego.app/ or as a guided walk-through) and `telegram <task>` (the bot, from
@BotFather to the first topic). Details per part are in `skills/herdrchat/references/`. To use it
with Claude Code, link it where skills are read, for example
`ln -s "$PWD/skills/herdrchat" ~/.claude/skills/herdrchat`.

## Logs

Everything the bot logs goes to `logs/<YYYY-MM-DD>.log` in the state folder (one file a
day, the last 14 kept) as `<time> <LEVEL> <text>`, besides its terminal: `grep ERROR
~/.local/state/herdrchat/<profile>/logs/*.log` finds
what went wrong, a retry that recovered is a `WARN`, and a crash leaves its stack there
before it is started again. Tokens and secrets are never logged. The
skill's `references/ops.md` explains the lines.

## Limits

- Narration blocks are a condensed version of the text Claude showed, not the exact words.
- Only Claude Code has a reader so far. codex, pi and the rest post nothing by themselves
  until each has a reader; what you type to them gets their screen in reply.
- Only text, images and rich text are passed on; files, stickers and the rest are not.
- An image that fails to upload three times is not sent; the group says so and why.
- Feishu takes tag names of at most 16 characters; a longer session or machine name is cut
  at its last `-`, `_` or `.` that fits (`build-agent-server` becomes `build-agent`).
- Avatars are drawn with `sips`, so only on macOS; elsewhere groups keep Feishu's default.
- Telegram: a bot cannot mute a topic for you; a topic you mute in Telegram stays fully
  quiet, "needs you" included. Closing a topic is documented for supergroups only, so an
  ended topic is marked by its name.
- Dialog buttons come from the screen's numbered menu; a dialog drawn some other way gets
  the screen and `/answer`, `/esc`.
