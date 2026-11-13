<div align="center">

# herdrchat

Every terminal hc runs, in the chat app you already use: Feishu or Telegram.

[English](README.md) · [简体中文](README.zh.md)

[![npm](https://img.shields.io/npm/v/herdrchat.svg)](https://www.npmjs.com/package/herdrchat)
[![CI](https://github.com/zhangxiangliang/herdrchat/actions/workflows/ci.yml/badge.svg)](https://github.com/zhangxiangliang/herdrchat/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/herdrchat.svg)](https://github.com/zhangxiangliang/herdrchat/blob/main/LICENSE)

</div>

herdr-app has official phone and desktop apps. But to use them away from your desk, your
phone has to reach the machine that runs hc, so you first need a VPN or a private network.
And on a small phone screen, working with an agent is clumsy.

Your chat app is already on your phone. herdrchat connects out to it by itself, so there
is nothing to set up on your network: no public IP, no VPN. Each herdr-app tab becomes a
Feishu group, or a topic in your private chat with the Telegram bot. You read what the
agent says while it works, tap buttons to answer its questions, send and receive images,
and see all terminals on one overview. A new room starts with the conversation so far.
Your phone rings only when an agent needs you or is done. It works with any agent hc
runs.

Use one app or both at once (a profile each). Slack and Discord may follow.

## Install

```bash
npx skills add zhangxiangliang/herdrchat   # the skill, for your agent (pick Symlink)
npm install -g herdrchat                   # the herdrchat command it runs
```

Then ask your agent:

| Command | What it does |
|---|---|
| `/herdrchat setup` | Sets everything up with you: the Feishu app or the Telegram bot, the settings, the first start. |
| `/herdrchat status` | Says whether it runs, and what is wrong if anything is. |
| `/herdrchat fix` | Finds the cause of a problem and fixes it. |
| `/herdrchat config` | Changes a setting: which terminals, which groups stay quiet, tags. |
| `/herdrchat feishu <task>` | Does a task in the Feishu developer console for you. |
| `/herdrchat telegram <task>` | The Telegram bot, from @BotFather to the first topic. |

On the command line, without an agent: `herdrchat init`, `start`, `stop`, `status`, `logs`;
`herdrchat install` runs it as a service that starts at login and comes back after a
crash. Add `--profile <name>` for a second chat app.

## Where things are

Settings in `~/.config/herdrchat/<profile>/config.env`, everything the bot writes in
`~/.local/state/herdrchat/<profile>/` (the profile is `default` unless you name one).
Updating or reinstalling herdrchat never touches them.

How it works and every setting: [docs/guide.md](docs/guide.md).

## License

MIT © [zhangxiangliang](https://github.com/zhangxiangliang)
