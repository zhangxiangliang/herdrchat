# Ops: running and looking after herdrchat

The bot is `bin/herdrchat.mjs`. It runs in an hc terminal named `herdrchat`, in the first
hc session listed in `HERDR_SESSIONS`; `herdrchat start` (re)starts it and keeps it
running (`node bin/cli.mjs` from a clone). A profile (`--profile` or `HERDRCHAT_PROFILE`,
default `default`; another one runs as the hc terminal `herdrchat-<profile>`) has its
settings in `~/.config/herdrchat/<profile>/config.env` and writes to
`~/.local/state/herdrchat/<profile>/` (call it `D` below), unless `HERDRCHAT_HOME` holds
both (`config.env`, `state/`). Its settings in Feishu itself (scopes, callbacks, icon,
versions) are in `references/feishu.md`.

Below, `S` is the first session in `HERDR_SESSIONS`.

## Is it running

```sh
HC_SESSION=S hc get herdrchat --json      # state "live"
HC_SESSION=S hc read herdrchat --lines 40 # its terminal: start lines, "[feishu] connected"
herdrchat status                              # running, folders, /auth, errors today
herdrchat start                               # restart: stops it in every session, waits until it reaches Feishu
```

A restart is needed after any code or `config.env` change. It is safe: what was posted
is in `D/state.json`, so it picks up where it stopped.

While the bot is down the user hears nothing, so:

- Never end with the bot down: `herdrchat start` exits 1 with its errors when the bot
  does not reach Feishu within 30 s; fix that before anything else.
- Never stop or restart the hc core (`hc server stop|restart`) of the session the bot
  runs in without saying so first, and run `herdrchat start` right after.
- Never start an hc core from an agent's shell: the core passes that shell's variables
  (`CLAUDECODE`, `CLAUDE_CODE_*`) to every terminal, and an agent started there treats
  itself as a sub-agent (Claude Code then saves no transcript). Start it with those
  variables removed (`env -u CLAUDECODE -u CLAUDE_CODE_CHILD_SESSION … hc server start`).
- A crash posts "🔴 herdrchat is down" in the direct chat (at most every 10 minutes) and
  the next connection posts "✅ herdrchat is back" with how long it was gone.

## Logs

`D/logs/<YYYY-MM-DD>.log`, one file a day, 14 kept, lines `<time> <LEVEL> <text>`:

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

## Did the change take effect

Check the live result, not only the code: count what actually happened in Feishu with
the bot's own client (`lib/chats/feishu/client.mjs` `createClient` with `loadConfig()`), for example:

- mentions in a group since a time: `im.v1.message.list` on the chat, then each item's
  `mentions` (a mention inside a card is not counted by Feishu, so it does not ring);
- a group's bot tags: `im.v2.bizEntityTagRelation.get` with `tag_biz_type: 'chat'`;
- whether a card was edited: `im.v1.message.get`, compare `update_time` with `create_time`.

Say which checks were run and which were not; "the code is there" is not "it works".

## Usual problems

| You see | Likely cause | Do |
|---|---|---|
| nothing posts | bot down, or `FEISHU_OWNER_OPEN_ID` unset | check it runs; the log says "owner not set" |
| a button gives error 200340 | the card callback is not set up | `references/feishu.md`: events and card callbacks |
| a dialog had no card | answered in the terminal before the card; or no numbered menu on screen | log: `blocked`; the card says `/answer` when it saw no menu |
| the phone rings too much | Feishu: not `/auth`ed; either app: settings | Feishu `/auth`; `HERDR_MUTED_SPACES` (quiet but for needs you and done), `HERDR_SILENT_SPACES` (nothing rings), per profile |
| a ⚠️ warning in the direct chat about acting as you | the token could not be refreshed | send `/auth` again |
| a group keeps an old name | its terminal is not live | it renames when the terminal is back |
| a Feishu call fails with 400 in a burst | a rate limit (tags: 5 a second) | space the calls; the bot queues tag calls |

## Trying a Feishu API safely

1. Read the official doc first (open.feishu.cn); write down the scope and limits.
2. Make real calls only with this repo's own code (the SDK or `fetch`), never through a
   third-party tool; reading another tool's docs or a dry run to learn a path is fine.
3. Test in a throwaway group the bot creates for it (`zz-test ...`), never in a
   terminal's group; label each test message ("Test 2/3: ...") so the user can tell
   which one rang.
4. Measure the result (an API field, a read-back) instead of assuming it; ask the user
   only what only a phone shows (did it ring).
5. Clean up in the same run: disband the test group, delete test labels and tags you
   made, recall test messages, delete scratch files.

## Before a commit

1. `npm test` passes.
2. Stage, then, as its own step, scan the staged files for anything real: session and
   machine names, the app id (`cli_`), open_ids (`ou_`), chat ids (`oc_`), message ids
   (`om_`), label ids (`ofg_`), the tenant's name, people's names, local paths. Read the
   result before committing; never chain the scan and the commit in one command.
3. Show the commit message (Conventional Commits; the body says why) and commit only
   after the user's yes. No push without its own yes.
