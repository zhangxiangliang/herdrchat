---
name: herdrchat
description: Set up, run and look after herdrchat, the chat front-end for hc that mirrors every herdr-app tab into a chat app - Feishu (one group per tab) or Telegram (one topic per tab in the bot's private chat), with dialog buttons, an overview and quiet phones - first setup of either app, running both side by side, start and stop, status and logs, /auth, settings, fixing problems, the Feishu developer console and @BotFather. Use for anything about herdrchat or its Feishu or Telegram bot, even when the user only says "set up the Telegram bot", "is it running", "it doesn't post", "mute the workers" or "publish the bot". Trigger with "/herdrchat", "/herdrchat setup", "/herdrchat status", "/herdrchat fix".
---

# herdrchat

herdrchat mirrors every herdr-app tab into a chat app: a group per tab in Feishu, a topic
per tab in the bot's private chat in Telegram; the conversation as it happens, dialogs as
buttons, an overview in the direct chat. One profile is one chat app (`HERDRCHAT_CHAT`);
to use both, run a profile each (`--profile telegram` beside the default Feishu one).

Its command is `herdrchat` (`node bin/cli.mjs` in a clone): check with `command -v
herdrchat`; when it is missing, ask before `npm install -g herdrchat`. A profile
(`--profile`, default `default`) keeps its settings in
`~/.config/herdrchat/<profile>/config.env` and its state in
`~/.local/state/herdrchat/<profile>/`; `herdrchat status` prints both.

## Commands

| Command | Do |
|---|---|
| `/herdrchat setup` | First ask which chat app (Feishu, Telegram, or both: one profile each). Telegram: `/herdrchat telegram setup`. Feishu, in order: `herdrchat init`; make the Feishu app (`references/feishu.md`: create, bot, scopes, events and callbacks); fill `config.env` with the user (app id, secret, `HERDR_SESSIONS`: the hc sessions herdr-app shows on this machine); `herdrchat start`; publish a version; get the user's open_id (they message the bot, it answers with it) into `FEISHU_OWNER_OPEN_ID`; start again. Optional: `/herdrchat auth`. |
| `/herdrchat status` | `herdrchat status`; explain each line; on errors, `/herdrchat fix`. |
| `/herdrchat start`, `/herdrchat stop` | Read `config.env` (its `HERDR_SESSIONS`) in one step, then `herdrchat start` / `stop` in the next; never both at once. |
| `/herdrchat logs` | `herdrchat logs --errors` (or `-n 100`); explain them with `references/ops.md` "Logs". |
| `/herdrchat auth` | The user sends `/auth` to the bot and allows it on Feishu's page; the app needs the user scopes in `references/feishu.md`. Then groups are muted, labels and pins follow. |
| `/herdrchat config` | Change a setting in `config.env` with the user (sessions, `HERDR_MUTED_SPACES`, `HERDR_SILENT_SPACES`, `HERDR_BOT_TAGS`, `HERDR_USER_TAGS`, `HERDR_HISTORY`, `HERDRCHAT_CHAT`; each is explained in `config.env.example`), read the file back, then restart. |
| `/herdrchat fix` | Find the cause from `herdrchat status`, the logs and the live result, then fix it: `references/ops.md`. |
| `/herdrchat feishu <task>` | Anything in the Feishu developer console: scopes, callbacks, publishing, the icon, deleting an app: `references/feishu.md`. |
| `/herdrchat telegram <task>` | The Telegram bot, as its own profile: `setup` (@BotFather, topic mode, token, owner id, first start), checking the token, quiet and silent spaces, what Telegram cannot do and what stands in: `references/telegram.md`. |

With no subcommand, run `herdrchat status` and suggest the next step from it.

## Rules

- Ask before anything outward-facing: publishing a version, applying scopes, deleting or
  disbanding anything, sending to a real group. One yes covers one action.
- Never print, screenshot or paste `FEISHU_APP_SECRET`, `TELEGRAM_BOT_TOKEN` or
  `user-token.json`; ask the user to paste a token into `config.env` themselves.
- A check that decides an action runs on its own first (read the config, then start;
  scan, then commit).
- Say what was checked on the live bot and what was not.

## References

- `references/feishu.md`: the bot's app in the Feishu developer console, with Ego or as a
  guided walk-through; the scopes this bot uses.
- `references/telegram.md`: the Telegram bot, from @BotFather to the first topic; what
  it does differently from Feishu.
- `references/ops.md`: running and checking the bot, its logs and state, the usual
  problems, trying a Feishu API safely, committing without a leak.
