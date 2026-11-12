---
name: herdrchat
description: Set up, run and look after herdrchat, the chat front-end for hc that mirrors every hc terminal into Feishu (one group per terminal, dialog buttons, an overview, quiet phones) - first setup with the Feishu app, start and stop, status and logs, /auth, settings, fixing problems, and the Feishu developer console (with Ego, or guided click by click). Use for anything about herdrchat or its Feishu bot, even when the user only says "set up the Feishu bot", "is it running", "it doesn't post", "mute the workers" or "publish the bot". Trigger with "/herdrchat", "/herdrchat setup", "/herdrchat status", "/herdrchat fix".
---

# herdrchat

herdrchat mirrors every terminal hc runs into a chat app, Feishu first: one group per
terminal, the conversation as it happens, dialogs as buttons, an overview in the direct
chat. Its command is `herdrchat` (`node bin/cli.mjs` in a clone): check with
`command -v herdrchat`; when it is missing, ask before `npm install -g herdrchat`. A
profile (`--profile`, default `default`) keeps its settings
in `~/.config/herdrchat/<profile>/config.env` and its state in
`~/.local/state/herdrchat/<profile>/`; `herdrchat status` prints both.

## Commands

| Command | Do |
|---|---|
| `/herdrchat setup` | First time, in order: `herdrchat init`; make the Feishu app (`references/feishu.md`: create, bot, scopes, events and callbacks); fill `config.env` with the user (app id, secret, `HERDR_SESSIONS`: the hc sessions herdr-app shows on this machine); `herdrchat start`; publish a version; get the user's open_id (they message the bot, it answers with it) into `FEISHU_OWNER_OPEN_ID`; start again. Optional: `/herdrchat auth`. |
| `/herdrchat status` | `herdrchat status`; explain each line; on errors, `/herdrchat fix`. |
| `/herdrchat start`, `/herdrchat stop` | Read `config.env` (its `HERDR_SESSIONS`) in one step, then `herdrchat start` / `stop` in the next; never both at once. |
| `/herdrchat logs` | `herdrchat logs --errors` (or `-n 100`); explain them with `references/ops.md` "Logs". |
| `/herdrchat auth` | The user sends `/auth` to the bot and allows it on Feishu's page; the app needs the user scopes in `references/feishu.md`. Then groups are muted, labels and pins follow. |
| `/herdrchat config` | Change a setting in `config.env` with the user (sessions, `HERDR_MUTED_SPACES`, `HERDR_SILENT_SPACES`, `HERDR_BOT_TAGS`, `HERDR_USER_TAGS`; each is explained in `config.env.example`), read the file back, then restart. |
| `/herdrchat fix` | Find the cause from `herdrchat status`, the logs and the live result, then fix it: `references/ops.md`. |
| `/herdrchat feishu <task>` | Anything in the Feishu developer console: scopes, callbacks, publishing, the icon, deleting an app: `references/feishu.md`. |

With no subcommand, run `herdrchat status` and suggest the next step from it.

## Rules

- Ask before anything outward-facing: publishing a version, applying scopes, deleting or
  disbanding anything, sending to a real group. One yes covers one action.
- Never print, screenshot or paste `FEISHU_APP_SECRET` or `user-token.json`.
- A check that decides an action runs on its own first (read the config, then start;
  scan, then commit).
- Say what was checked on the live bot and what was not.

## References

- `references/feishu.md`: the bot's app in the Feishu developer console, with Ego or as a
  guided walk-through; the scopes this bot uses.
- `references/ops.md`: running and checking the bot, its logs and state, the usual
  problems, trying a Feishu API safely, committing without a leak.
