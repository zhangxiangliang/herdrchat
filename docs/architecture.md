# herdrchat architecture

herdrchat has two kinds of plug-ins that grow over time: **chat apps** (Feishu and
Telegram now, Slack and Discord later) and **agents**, each read by its reader (Claude
Code, Codex and OpenCode now, then pi). The core between them knows neither. This page says where everything is and
how to add one of each.

## The parts

```
bin/
  cli.mjs                  herdrchat setup|pair|init|start|stop|status|logs|install|uninstall|hooks|run|version
  herdrchat.mjs            wires the parts: config, log, the chat app, the core
lib/
  core/                    the same for every chat app and every agent
    engine.mjs             follows hc, keeps one room per herdr-app tab, posts what agents
                           say, dialogs and clicks, what you type, the overview
    hc.mjs  events.mjs     hc: commands, its live event stream, the sessions on a machine
    views.mjs              which view of a terminal is followed (hc core id + tN)
    cursor.mjs  home.mjs   what was posted already; reading an agent's log files
    menu.mjs               a dialog's options, read from the screen
    asks.mjs               what an agent asks through herdrchat's hook (its request, your answer)
    hooks.mjs              herdrchat hooks: the hook in Claude Code's and Codex's settings
    config.mjs  log.mjs    config.env, state.json, the daily log
    service.mjs            herdrchat as a launchd or systemd service
    readers/               one reader per agent (the contract is in index.mjs)
  hooks/ask.sh             the PermissionRequest hook itself (sh and hc only)
  chats/
    contract.mjs           what a chat app gives the core, and the check for it
    index.mjs              the list of chat apps
    feishu/                index.mjs (the contract), client.mjs (API calls), render.mjs (cards), overview.mjs, avatar.mjs, userauth.mjs
    telegram/              index.mjs (the contract), client.mjs (API calls), render.mjs (HTML, buttons)
test/
  fakes.mjs                a fake chat app, a fake hc and a fake reader
  engine.test.mjs          the core, run on the fakes; the apps' contracts
  *.test.mjs               the parts one by one
```

The rules that keep it this way:

- The core never imports from `lib/chats/`, and a chat app never imports from the
  core's engine. They meet only through the contract in `lib/chats/contract.mjs`.
- Everything a chat app does is in its own folder, including what only it has (Feishu's
  tags, avatars and acting as you).
- The core gets hc, the readers and state.json passed in, so the tests swap them for
  fakes. A behaviour of the core gets a test in `test/engine.test.mjs`.
- Words the core uses: a **room** is where one tab is mirrored (a Feishu group, a
  Telegram topic); `k` is the core's key for a tab's terminal; `room` and `message`
  are the app's own ids, which the core keeps as given.

## Adding a chat app

1. Read the app's official docs first, for each line of the contract: how a room is
   made (a group, a topic, a channel), how a message is edited, buttons and their
   callbacks, reactions, images both ways, how the phone is kept quiet, the rate limits.
   Write down what it cannot do and what stands in for it.
2. Make `lib/chats/<app>/index.mjs` that exports `requires` (the config.env keys it
   cannot start without) and `create(ctx)` returning every member of `CHAT_MEMBERS` in
   `lib/chats/contract.mjs`. Keep the app's API calls in a `client.mjs` beside it.
3. List it in `lib/chats/index.mjs`.
4. Add its keys to `config.env.example` and to the comment at the top of
   `lib/core/config.mjs`.
5. Add a test that `checkChat(create(...))` passes (see the Feishu one in
   `test/engine.test.mjs`), and tests for its own message conversions.
6. Add `skills/herdrchat/references/<app>.md`: setting the app up, step by step.
7. Run it in its own profile (`herdrchat start --profile <app>` with
   `HERDRCHAT_CHAT=<app>` in that profile's config.env), so the running Feishu bot is
   not touched.

## Adding an agent

1. Read how the agent keeps its conversation on disk, from its docs or its source: where
   the log is, how to find the one for a running terminal, how a turn's last answer is
   marked.
2. Write `lib/core/readers/<agent>.mjs` exporting `app` (the name the agent gives in its
   hc status, `status.app`), `processes` (the names its process runs under, as hc's
   `foreground` reports them), `after(session, address, cursor)` and
   `rest(session, address, cursor)`. The items it returns are described at the top of
   `lib/core/readers/index.mjs`.
3. List it in `LISTED` in `lib/core/readers/index.mjs`; `checkReader` checks it there.
4. Add tests with a sample log in `test/readers.test.mjs`.
5. Add a row to the readers table in `docs/guide.md`.
