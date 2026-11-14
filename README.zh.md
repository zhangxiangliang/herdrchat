<div align="center">

# herdrchat

hc（[herdr](https://herdr.dev)）的聊天客户端：在飞书或 Telegram 里查看和回复 hc 的每一个终端。

[English](README.md) · [简体中文](README.zh.md)

[![npm](https://img.shields.io/npm/v/herdrchat.svg)](https://www.npmjs.com/package/herdrchat)
[![CI](https://github.com/zhangxiangliang/herdrchat/actions/workflows/ci.yml/badge.svg)](https://github.com/zhangxiangliang/herdrchat/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/herdrchat.svg)](https://github.com/zhangxiangliang/herdrchat/blob/main/LICENSE)

</div>

**herdr-app 是 hc 的电脑和手机客户端；herdrchat 是 hc 的聊天客户端。**

[herdr](https://herdr.dev) 让你的编程 agent（Claude Code、codex、pi……）跑在不会断的终端里：
**hc**（herdr-core）让它们一直跑着，herdr-app 按空间和标签页把它们展示出来。
但想在外面用 herdr-app，手机得能连到跑 hc 的机器，所以要先折腾 VPN 或内网；而且在手机的小屏幕上和 agent 交互，体验并不好。

herdrchat 把同样这些终端，放进你手机上本来就有的聊天软件里。它自己主动连到飞书或 Telegram，网络上什么都不用配：不要公网 IP，也不要 VPN。
herdr-app 的每个标签页，在飞书里是一个群，在 Telegram 里是和 bot 私聊中的一个话题：
agent 干活时说的话实时可见，它问你的问题点按钮就能回答，图片双向都能传，所有终端汇总在一张总览里。
新开的群或话题会先补上之前的对话；只有 agent 需要你、或者做完的时候手机才会响
（飞书要先给 bot 发一次 `/auth`；Telegram 直接就是这样）。

目前 Claude Code、Codex、OpenCode 和 Pi 是完整同步的，它们的对话框都能点按钮回答（Pi 自己不会弹对话框，扩展弹出的对话框从屏幕上读）。其他 agent 在你给它发消息时会回一次屏幕内容，
等 herdrchat 学会读它们的对话记录以后，也会完整同步。每条消息底部有一行小字，写着它来自哪里、现在的状态：harness、模型、git 分支、上下文用了多少，以及 5 小时和 7 天的额度（`claude · claude-opus-5-5 · main · context 23% (234k) · 5-hour 2% · 7-day 57%`）。

## 需要什么

- **herdr**：herdrchat 是基于它做的，没有它什么都做不了。请先从 [herdr.dev](https://herdr.dev) 安装
  （也可以让编程 agent 帮你装：`/herdrchat setup` 会主动问你）；它的 **hc** 要在这台机器上跑着，至少有一个 session。
- **Node.js 20** 或更新版本，系统是 **macOS 或 Linux**。
- **飞书**：一个能创建并发布企业自建应用的飞书团队（暂不支持 Lark 国际版）。
  **Telegram**：一个 Telegram 账号。可以只用一个，也可以两个同时用。

下面会用到几个词：**session** 是一个 hc 核心（以及它的终端）；**空间**和**标签页**是 herdr-app 给终端分组的方式；
**profile** 是 herdrchat 对一个聊天软件的一套配置（不指定就叫 `default`）。

## 安装

```bash
npm install -g herdrchat                    # herdrchat 命令
npx skills add zhangxiangliang/herdrchat    # 可选：给编程 agent 用的 skill
```

skill 会教你的编程 agent（Claude Code、Codex……）替你配置和照看 herdrchat。
`skills` 工具问你选 Copy 还是 Symlink 时，选 Symlink，以后更新才会同步给 agent。

## 配置

**让 agent 帮你：** 对它说 `/herdrchat setup`。它会先问你用哪个聊天软件，然后一步步带你配好，
飞书后台的操作，装了 [Ego Lite](https://lite.ego.app/) 浏览器它会替你点；没装的话，它会问你要不要装，不装就一步步告诉你点哪里。

**在终端里**（步骤和 agent 一样，一个个问你；区别是 agent 还能替你在飞书后台点，终端做不到）：

```bash
herdrchat setup
```

它会问你用哪个聊天软件，让你粘贴 bot 的 token（或飞书应用的 App ID 和 Secret）并当场检查，
帮你选好要同步的 hc session（不改就是 `default`），然后启动 bot，并给你一个 6 位数字：
把它发给 bot，bot 就认出你是主人。最后问你要不要装成系统服务。不用改文件，也不用复制任何 id。

怎么建 Telegram bot 或飞书应用，以及想自己改配置文件的做法，见[详细说明](docs/guide.md#set-up-telegram)（英文）。

## 使用

在聊天软件里：在某个终端的群或话题里打字，就是在跟它说话；点卡片上的按钮回答它的问题。
在和 bot 的私聊里：`/ls` 看总览，`/new` 启动一个终端，`/kill` 结束一个终端。

| 对 agent 说 | 做什么 |
|---|---|
| `/herdrchat setup` | 和你一起从零配好：飞书应用或 Telegram bot、配置、第一次启动。 |
| `/herdrchat status` | 告诉你它在不在跑，有问题的话问题在哪。 |
| `/herdrchat fix` | 找出问题的原因并修好。 |
| `/herdrchat config` | 改配置：接哪些终端、哪些保持安静、标签。 |
| `/herdrchat start`、`stop`、`install`、`logs`、`auth` | 和下面的命令一样，只是会先检查。 |
| `/herdrchat feishu <任务>` | 替你在飞书开发者后台完成操作（用 [Ego Lite](https://lite.ego.app/) 浏览器，或者一步步带你点）。 |
| `/herdrchat telegram <任务>` | Telegram bot：从 @BotFather 一直到第一个话题。 |

命令行：`herdrchat setup`、`pair`、`init`、`start`、`stop`、`status`、`logs`、`install`、`uninstall`、`hooks`、`version`；
只输入 `herdrchat` 会列出全部。加上 `--profile <名字>`，可以再开一个聊天软件。

用 Claude Code 和 Codex 的话，推荐运行 `herdrchat hooks install`（它会先列出要改什么，问过你才改）。
它把 herdrchat 的 hook 加进它们自己的配置里：它们问你的事（权限、Claude 的提问和计划）会用它们自己的原话和选项发到聊天里，
你点的按钮直接回给它们，不用读屏幕。不装的话，还是和以前一样从屏幕上读对话框。
Codex 第一次会让你确认信任这个新 hook（在 Codex 里打开 `/hooks`）；而且 hook 在等的时候，Codex 自己不显示提示框：
想在终端里回答，就点卡片上的「Answer in the terminal」。`herdrchat hooks uninstall` 可以把它去掉。
Codex 的提问（Plan 模式里的，以及它不等你回答就继续的那种）不需要 hook：直接从它自己的会话记录里读。
对 Pi，它装的是一个很小的 Pi 扩展（`~/.pi/agent/extensions/herdrchat.js`），告诉 herdrchat 每个 Pi 在写哪个会话，
这样同一个文件夹里同时开的几个 Pi 各回各的群（已经在运行的 Pi 里执行一次 `/reload`）。

## 更新

npm 上有新版本时，机器人会在私聊里说一次，卡片上有一个**更新**按钮。也可以在终端里：

```bash
herdrchat update                 # 更新到最新版，skill 和 hook 一起更新
herdrchat update 1.10.2          # 退回到这个版本
```

两种方式都是用 npm 安装，装好后正在运行的机器人会在一分钟内自己重启到新版本（中间断开几秒），回来后会告诉你现在是哪个版本。没有你点按钮，herdrchat 绝不会自己更新。如果是手动运行的机器人（`herdrchat run`），它会提示你自己重启。

如果你用的是 1.11.0 之前的版本（还没有 `herdrchat update`），需要手动更新一次：`npm install -g herdrchat@latest`，然后每个 profile 运行一次 `herdrchat start`。

## 文件在哪

配置在 `~/.config/herdrchat/<profile>/config.env`，bot 写的东西都在 `~/.local/state/herdrchat/<profile>/`。
更新或重装 herdrchat 都不会动它们。`herdrchat status` 会把这两个位置都打印出来。

## 隐私和安全

- 终端里显示的内容会发到飞书或 Telegram 的服务器上。Telegram 的 bot 聊天不是端到端加密的。
- 只有 `config.env` 里设置的 owner 能往你的终端里输入；其他人发的都会被忽略。
- 飞书的 App Secret、Telegram 的 bot token 要像密码一样保管：谁拿到了，谁就能操作你的终端。
- 飞书里 bot 打的标签，你整个团队都看得见（`HERDR_BOT_TAGS=off` 可以关掉）。
- 装了 `herdrchat hooks install` 之后，在聊天里点一下就能批准 Claude Code 或 Codex 要做的事，和在终端里按键一样。

## 卸载

每个 profile 运行一次 `herdrchat uninstall`，再运行 `herdrchat hooks uninstall`，然后 `npm rm -g herdrchat`，删掉 `~/.config/herdrchat`
和 `~/.local/state/herdrchat`，最后删掉飞书应用或 Telegram bot（在 @BotFather 里用 `/deletebot`）。

工作原理和全部配置：[docs/guide.md](docs/guide.md)（英文）。

## 许可证

MIT © [zhangxiangliang](https://github.com/zhangxiangliang)
