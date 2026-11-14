<div align="center">

# herdrchat

The chat client for hc ([herdr](https://herdr.dev)): see and answer every hc terminal from Feishu or Telegram.

[English](README.md) · [简体中文](README.zh.md)

[![npm](https://img.shields.io/npm/v/herdrchat.svg)](https://www.npmjs.com/package/herdrchat)
[![CI](https://github.com/zhangxiangliang/herdrchat/actions/workflows/ci.yml/badge.svg)](https://github.com/zhangxiangliang/herdrchat/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/herdrchat.svg)](https://github.com/zhangxiangliang/herdrchat/blob/main/LICENSE)

</div>

**herdr-app is hc's desktop and phone client; herdrchat is hc's chat client.**

[herdr](https://herdr.dev) runs your coding agents (Claude Code, codex, pi, …) in
terminals that stay alive: **hc** (herdr-core) keeps them running, and herdr-app shows
them in spaces and tabs. But to use herdr-app away from your desk, your phone has to
reach the machine that runs hc, so you first need a VPN or a private network, and working
with an agent on a small phone screen is clumsy.

herdrchat shows the same terminals in a chat app you already have on your phone. It connects out to Feishu or Telegram by
itself, so there is nothing to set up on your network: no public IP, no VPN. Each
herdr-app tab gets its own Feishu group, or a topic in your private chat with the
Telegram bot. You read what the agent says while it works, tap buttons to answer its
questions, send and receive images, and see all terminals in one overview. A new group or
topic starts with the conversation so far, and your phone rings only when an agent needs
you or is done (on Feishu once you have sent `/auth` to the bot; on Telegram right away).

Claude Code, Codex, OpenCode and Pi are mirrored fully, their dialogs answered with buttons
(Pi asks nothing itself; an extension's dialog is read off the screen).
Other agents show their screen when you type to them, until herdrchat learns to read their
conversations too. Under every post a small line says where it came from and how it stands: the
harness, model and git branch, how full the context is, and the 5-hour and 7-day limits
(`claude · claude-opus-5-5 · main · context 23% (234k) · 5-hour 2% · 7-day 57%`).

## You need

- **herdr**: herdrchat is built on it and does nothing without it. Install it from
  [herdr.dev](https://herdr.dev) first (or let your coding agent do it with you:
  `/herdrchat setup` offers to); its **hc** must run on this machine, with at least one
  session.
- **Node.js 20** or newer, on **macOS or Linux**.
- **Feishu**: a Feishu team (not Lark) where you may create a custom app and publish it.
  **Telegram**: a Telegram account. Use one app, or both at once.

A few words used below: a **session** is one hc core (its terminals); a **space** and a
**tab** are how herdr-app groups terminals; a **profile** is one herdrchat setup for one
chat app (`default` unless you name another).

## Install

```bash
npm install -g herdrchat                    # the herdrchat command
npx skills add zhangxiangliang/herdrchat    # optional: the skill, for your coding agent
```

The skill teaches your coding agent (Claude Code, Codex, …) to set herdrchat up and look
after it for you. When the `skills` tool asks Copy or Symlink, pick Symlink, so updates
reach the agent.

## Set up

**With your agent:** ask it `/herdrchat setup`. It asks which chat app, then walks you
through everything, clicking in the Feishu console for you when it can.

**In the terminal** (the same steps, asked one by one; the agent can also click through
the Feishu console for you, with the [Ego Lite](https://lite.ego.app/) browser, which the
terminal cannot; without Ego it tells you what to click):

```bash
herdrchat setup
```

It asks which chat app, takes the bot's token (or the Feishu app's keys) and checks them
at once, picks your hc sessions (`default` unless you say otherwise), starts the bot, and
shows a 6-digit code: send it to the bot and it knows you are its owner. Last, it offers
to keep it running as a service. No file to edit, no id to copy.

Making the Telegram bot or the Feishu app, and doing it all by editing the settings file
instead: the [guide](docs/guide.md#set-up-telegram).

## Use

In your chat app: type in a terminal's group or topic to talk to it; tap a card's buttons
to answer a question. In the direct chat with the bot: `/ls` for the overview, `/new` to
start a terminal, `/kill` to end one.

| Ask your agent | What it does |
|---|---|
| `/herdrchat setup` | Sets everything up with you: the Feishu app or the Telegram bot, the settings, the first start. |
| `/herdrchat status` | Says whether it runs, and what is wrong if anything is. |
| `/herdrchat fix` | Finds the cause of a problem and fixes it. |
| `/herdrchat config` | Changes a setting: which terminals, which ones stay quiet, tags. |
| `/herdrchat start`, `stop`, `install`, `logs`, `auth` | The same as the commands below, with checks first. |
| `/herdrchat feishu <task>` | Does a task in the Feishu developer console (with the [Ego Lite](https://lite.ego.app/) browser, or step by step). |
| `/herdrchat telegram <task>` | The Telegram bot, from @BotFather to the first topic. |

On the command line: `herdrchat setup`, `pair`, `init`, `start`, `stop`, `status`, `logs`, `install`,
`uninstall`, `hooks`, `version`; `herdrchat` alone lists them. Add `--profile <name>` to run a
second chat app beside the first.

Recommended for Claude Code and Codex: `herdrchat hooks install` (it shows what it changes
and asks first). It adds herdrchat's hook to their own settings, so what they ask you (a
permission, Claude's questions and plans) comes to the chat in their own words and options,
and your tap goes straight back to them, with no screen read. Without it, the dialog is
read off the screen, as before. Codex asks you once to trust the new hook (`/hooks` in
Codex), and while the hook waits Codex shows no prompt of its own: tap "Answer in the
terminal" on the card to get it there. `herdrchat hooks uninstall` takes it out. Codex's
questions (in Plan mode, and the ones it asks without waiting) need no hook: they are read
from its own log. For Pi it puts in a small Pi extension instead
(`~/.pi/agent/extensions/herdrchat.js`), which tells herdrchat which session each pi
writes, so two pi in one folder each keep to their own room (in a pi that runs already:
`/reload`).

## Update

When npm has a newer herdrchat, the bot says so once in your direct chat, with an
**Update** button. Or in a terminal:

```bash
herdrchat update                 # the latest, with its skill and hook
herdrchat update 1.10.2          # back to that version
```

Either way npm installs it, and every running bot starts again on it by itself within a
minute (a few seconds without the bot), then says which version it runs now. herdrchat
never updates without your tap. A bot you run by hand (`herdrchat run`) says it needs a
restart instead.

From a version before 1.11.0 (no `herdrchat update` yet), once by hand:
`npm install -g herdrchat@latest`, then `herdrchat start` for each profile.

## Where things are

Settings in `~/.config/herdrchat/<profile>/config.env`, everything the bot writes in
`~/.local/state/herdrchat/<profile>/`. Updating or reinstalling herdrchat never touches
them. `herdrchat status` prints both.

## Privacy and safety

- What your terminals show goes to Feishu's or Telegram's servers. Telegram bot chats are
  not end-to-end encrypted.
- Only the owner set in `config.env` can type into your terminals; everyone else is
  ignored.
- Keep the Feishu app secret or the Telegram bot token like a password: whoever has it
  can drive your terminals.
- On Feishu, the bot's tags are visible to your whole team (`HERDR_BOT_TAGS=off` turns
  them off).
- With `herdrchat hooks install`, a tap in the chat can allow what Claude Code or Codex
  asks to do, as a key in the terminal can.

## Remove

`herdrchat uninstall` (for each profile), `herdrchat hooks uninstall`, `npm rm -g herdrchat`, delete
`~/.config/herdrchat` and `~/.local/state/herdrchat`, then delete the Feishu app or the
Telegram bot (@BotFather, `/deletebot`).

How it works and every setting: [docs/guide.md](docs/guide.md).

## License

MIT © [zhangxiangliang](https://github.com/zhangxiangliang)
