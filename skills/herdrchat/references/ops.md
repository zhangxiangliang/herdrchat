# Ops: running and looking after herdrchat

The bot (`bin/herdrchat.mjs` in the installed package) runs one of two ways:

- as a **service** of the system, after `herdrchat install` (launchd on macOS, systemd on
  Linux): it starts at login and comes back after a crash; recommended;
- in an **hc terminal** named `herdrchat` (`herdrchat-<profile>` for another profile), in
  the first session of `HERDR_SESSIONS`, after `herdrchat start` without a service.

`herdrchat status` says which, and where the profile's files are: settings in
`~/.config/herdrchat/<profile>/config.env`, state and logs in
`~/.local/state/herdrchat/<profile>/` (call it `D` below). The app's own settings (Feishu
scopes, callbacks; the Telegram bot's topic mode) are in `references/feishu.md` and
`references/telegram.md`.

## Is it running

```sh
herdrchat status                       # how it runs, sessions, keys set or missing, errors today
herdrchat logs --errors                # what went wrong today ("[feishu] connected" / "[telegram] connected as @…" when in)
herdrchat start                        # restart: stops it everywhere, waits up to a minute until it is in
herdrchat install                      # make it a service: starts at login, back after a crash
launchctl print gui/$(id -u)/app.herdrchat.<profile>   # macOS: the service's state, pid, last exit
systemctl --user status herdrchat-<profile>            # Linux: the same
```

A restart is needed after any code or `config.env` change. It is safe: what was posted
is in `D/state.json`, so it picks up where it stopped.

While the bot is down the user hears nothing, so:

- Never end with the bot down: `herdrchat start` exits 1 with its errors when the bot
  does not reach its chat app within 60 s; fix that before anything else.
- Never stop or restart the hc core (`hc server stop|restart`) of the session the bot
  runs in without saying so first, and run `herdrchat start` right after.
- Never start an hc core from an agent's shell: the core passes that shell's variables
  (`CLAUDECODE`, `CLAUDE_CODE_*`) to every terminal, and an agent started there treats
  itself as a sub-agent (Claude Code then saves no transcript). Start it with those
  variables removed (`env -u CLAUDECODE -u CLAUDE_CODE_CHILD_SESSION … hc server start`).
- A crash posts "🔴 herdrchat is down" in the direct chat (at most every 10 minutes) and
  the next connection posts "✅ herdrchat is back" with how long it was gone.

## Logs

`D/logs/<YYYY-MM-DD>.log`, one file a day, 14 kept, lines `<time> <LEVEL> <text>`. Run as a service, what the process printed before its log was open (a crash at start) is in `D/logs/service.out.log`:

```sh
grep -h ERROR D/logs/*.log | tail -20   # what went wrong
grep -h WARN  D/logs/*.log | tail -20   # retries that recovered, lost /auth
grep -h ' <- \| -> ' D/logs/$(date -u +%F).log | tail   # posts out, your messages in
```

| Line | Means |
|---|---|
| `<- S/tN: 3 items (claude-code, live card)` | posted to a group, into the live card |
| `<- S/tN: blocked (4 options)` | a dialog card went out |
| `-> S/tN: picked 1. Yes` | a card button was pressed |
| `-> S/tN: <text>` | your message was typed into the terminal |
| `turn S/tN: done` | hc said a turn ended |
| `acting as you: on` / `off` | `/auth` token usable / lost |
| `uncaught:` + stack | the bot crashed; it was started again |

## State

`D/state.json` (never edit it while the bot runs: `herdrchat stop` first,
`herdrchat start` after):

| Key | Holds |
|---|---|
| `chats` | per terminal (`S|tN`, or `@machine|machine/tN`): group id, name, tags, label, muted, ended |
| `cursors` | per terminal: what was posted (ids, time), the open live card |
| `tags`, `labels`, `spaces` | ids of the bot tags, your labels, each space's avatar color |
| `overview`, `pinned`, `reacts` | the overview card, pinned groups, messages waiting for their OK |

Read it with a short `node -e` and print only what you need. `D/user-token.json` is
your token after `/auth`: never print it.

## Usual problems

| You see | Likely cause | Do |
|---|---|---|
| nothing posts | bot down, or the owner not set (`FEISHU_OWNER_OPEN_ID`, `TELEGRAM_OWNER_ID`) | `herdrchat status`; the log says "owner not set": `herdrchat pair` |
| Telegram: no topic appears | topic mode off | log: "topic mode is off"; BotFather's mini app, the bot, Threaded Mode, then start again |
| Telegram: `telegram poll: ... 409` | another copy polls the same token | stop it (another machine?), then start once |
| a button gives error 200340 | the card callback is not set up | `references/feishu.md`: events and card callbacks |
| a dialog had no card | answered in the terminal before the card; or no numbered menu on screen | log: `blocked`; the card says `/answer` when it saw no menu |
| the phone rings too much | Feishu: not `/auth`ed; either app: settings | Feishu `/auth`; `HERDR_MUTED_SPACES` (quiet but for needs you and done), `HERDR_SILENT_SPACES` (nothing rings), per profile |
| a ⚠️ warning in the direct chat about acting as you | the token could not be refreshed | send `/auth` again |
| a group keeps an old name | its terminal is not live | it renames when the terminal is back |
| a Feishu call fails with 400 in a burst | a rate limit (tags: 5 a second) | space the calls; the bot queues tag calls |
| `herdrchat start` says it did not reach its chat app | wrong keys, or no network | `herdrchat logs --errors`; check the keys in `config.env` |
