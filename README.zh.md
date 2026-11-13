<div align="center">

# herdrchat

hc 跑的每个终端，都能在你常用的聊天软件里看到和回复：飞书或 Telegram。

[English](README.md) · [简体中文](README.zh.md)

[![npm](https://img.shields.io/npm/v/herdrchat.svg)](https://www.npmjs.com/package/herdrchat)
[![CI](https://github.com/zhangxiangliang/herdrchat/actions/workflows/ci.yml/badge.svg)](https://github.com/zhangxiangliang/herdrchat/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/herdrchat.svg)](https://github.com/zhangxiangliang/herdrchat/blob/main/LICENSE)

</div>

herdr-app 官方有手机端和电脑端。但想在外面用，手机得能连到跑 hc 的机器，
所以要先折腾 VPN 或内网环境；而且在手机的小屏幕上和 agent 交互，体验并不好。

聊天软件本来就在你手机上。herdrchat 自己主动连过去，网络上什么都不用配：不要公网 IP，也不要 VPN。
herdr-app 的每个标签页，在飞书里是一个群，在 Telegram 里是和 bot 私聊中的一个话题：
agent 干活时说的话实时可见，它问你的问题点按钮就能回答，图片双向都能传，所有终端汇总在一张总览里。
新开的群或话题会先补上之前的对话。只有 agent 需要你、或者做完的时候手机才会响。
hc 能跑的 agent 都能用，我们自己用下来非常顺畅。

可以只用一个，也可以两个同时用（各开一个 profile）。后面有精力的话，也会考虑接入 Slack、Discord。

## 安装

```bash
npx skills add zhangxiangliang/herdrchat   # 给 agent 用的 skill（选 Symlink）
npm install -g herdrchat                   # skill 要用到的 herdrchat 命令
```

然后对你的 agent 说：

| 命令 | 做什么 |
|---|---|
| `/herdrchat setup` | 和你一起从零配好：飞书应用或 Telegram bot、配置、第一次启动。 |
| `/herdrchat status` | 告诉你它在不在跑，有问题的话问题在哪。 |
| `/herdrchat fix` | 找出问题的原因并修好。 |
| `/herdrchat config` | 改配置：接哪些终端、哪些群保持安静、标签。 |
| `/herdrchat feishu <任务>` | 替你在飞书开发者后台完成操作。 |
| `/herdrchat telegram <任务>` | Telegram bot：从 @BotFather 一直到第一个话题。 |

不用 agent 也可以直接在命令行里用：`herdrchat init`、`start`、`stop`、`status`、`logs`；
`herdrchat install` 把它装成系统服务，开机自动启动，崩溃后自动重启。第二个聊天软件加 `--profile <名字>`。

## 文件在哪

配置在 `~/.config/herdrchat/<profile>/config.env`，bot 写的东西都在 `~/.local/state/herdrchat/<profile>/`（没指定 profile 时就是 `default`）。
更新或重装 herdrchat 都不会动它们。

工作原理和全部配置：[docs/guide.md](docs/guide.md)（英文）。

## 许可证

MIT © [zhangxiangliang](https://github.com/zhangxiangliang)
