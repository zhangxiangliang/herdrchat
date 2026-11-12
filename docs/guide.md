# herdrchat guide

How herdrchat works and every setting, for when the README is not enough.

herdrchat is a chat front-end for hc: every terminal hc runs, followed and answered in a
chat app. Feishu is the first (one bot); Slack, Discord and Telegram may follow, on the
same core (hc events, a reader per agent, dialogs, the overview) with an adapter each.

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

## How it works: hc, plus a reader per agent

**hc is the backbone.** The bot follows `hc events --json` for each session (format:
herdr-core `schema/README.md`, "Events"). From hc it learns which terminals exist, where
herdr-app shows them, their status, and when a turn ends (`turn` event: the status left
`working`). Typing from a group goes through `hc send`.

**A reader gives the conversation.** hc can show only the screen, and the screen is a
picture: long output is folded, and you cannot tell your words from the agent's. So for
each agent a reader reads the agent's own records. The status hc reports names the agent
(`status.app`), and that name picks the reader (`lib/readers/`):

| `status.app` | reader | reads |
|---|---|---|
| `claude-code` | `lib/readers/claude.mjs` | its transcript: the terminal's foreground pid names the session in `~/.claude/sessions/<pid>.json` |
| anything else | none (default) | the screen, through `hc read` |

On another machine, a reader reads the same files through `hc exec --on`. To add an
agent, write `lib/readers/<agent>.mjs` (the contract is at the top of
`lib/readers/index.mjs`) and list it there.

## What a group shows

- A program with a reader:
  - while it works: one "⌛️ Working…" card per turn (then "✅ Worked"), edited every 5
    seconds with what is new: what it says, your prompts (typed in the terminal or sent
    mid-turn) as **You:**, and each tool it calls as one line (`▸ Bash: Run the tests`).
    It shows the program is alive, as herdr-app does, and since an edit is not a new
    message, the phone does not ring every few seconds;
  - when the turn ends: its last answer, as a new message. Without `/auth` you are
    notified when a turn starts and when it is done; with it, groups are muted and only
    an @ under the answer rings (see "Optional: let the bot act as you").
  - Images too: ones it looked at (a screenshot, an image file it read) and ones you
    pasted in the terminal, shown in the card.
  - What you sent from the group is not repeated.
- A program without one: the last 150 lines of its screen when a turn ends.
- A turn that ends on `blocked` (permission, question, auth): what it said first, then
  a red "⚠️ Needs you" card. When the screen shows a numbered menu (as Claude Code's
  permission and question dialogs do), the card shows only the dialog, as text, with a
  button per option; a multi-select also has "Next ⇥", a "Type something" option a box to
  type in, and every card "Esc". Without a menu the card shows the screen and how to
  answer by typing. Once the dialog is gone the card turns to "✅ Done".

## Answering a dialog from Feishu

A button presses that option's number key in the terminal (Next presses tab, Esc esc).
Before it presses anything, the bot reads the screen again and checks that it still
shows the same dialog (a hash of it, from its top border to its last option) and the
same option, so an old card can never answer a newer dialog that looks alike. After the
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
A shell reports no turns, so after you type a command into one, the bot posts its screen.

## Commands

- Direct chat: `/ls` (the overview again at the bottom of the chat; the old one is
  recalled), `/new <session> <space>/<tab> [command]` (start one; default `claude`;
  `--cwd <dir>` first to pick its folder), `/kill <session> <address>`, `/auth` (see
  below).
- In a terminal's group: any text goes to it (marked THINKING once typed in, then OK when
  the turn that took it is over); an image (alone or in a rich text message) is sent
  beside the terminal with `hc put`, on its machine, and its path is typed in with your
  text, so an agent like Claude Code opens it; `/screen`, `/answer <text>` (type into the
  dialog it waits on, as is), `/esc`. Dialog cards have buttons.

## Set up

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
`SKILL.md`): `/herdrchat setup`, `status`, `start`, `stop`, `logs`, `auth`, `config`, `fix`
and `feishu <task>` (the developer console, with Ego Lite from https://lite.ego.app/ or as
a guided walk-through). Details per part are in `skills/herdrchat/references/`. To use it
with Claude Code, link it where skills are read, for example
`ln -s "$PWD/skills/herdrchat" ~/.claude/skills/herdrchat`.

## Logs

Everything the bot logs goes to `logs/<YYYY-MM-DD>.log` in the state folder (one file a
day, the last 14 kept) as `<time> <LEVEL> <text>`, besides its terminal: `grep ERROR
~/.local/state/herdrchat/default/logs/*.log` finds
what went wrong, a retry that recovered is a `WARN`, and a crash leaves its stack there
before it is started again. Tokens and secrets are never logged. The
skill's `references/ops.md` explains the lines.

## Limits

- Narration blocks are a condensed version of the text Claude showed, not the exact words.
- Only Claude Code has a reader so far. codex, pi and the rest get their screen, at turn
  end only, until each has a reader.
- Only text, images and rich text are passed on; files, stickers and the rest are not.
- An image that fails to upload three times is not sent; the group says so and why.
- Feishu takes tag names of at most 16 characters; a longer session or machine name is cut
  at its last `-`, `_` or `.` that fits (`build-agent-server` becomes `build-agent`).
- Avatars are drawn with `sips`, so only on macOS; elsewhere groups keep Feishu's default.
- Dialog buttons come from the screen's numbered menu; a dialog drawn some other way gets
  the screen and `/answer`, `/esc`.
