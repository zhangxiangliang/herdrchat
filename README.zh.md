<div align="center">

# herdrchat

hc 跑的每个终端，都能在你常用的聊天软件里看到和回复。先支持飞书。

[English](README.md) · [简体中文](README.zh.md)

[![npm](https://img.shields.io/npm/v/herdrchat.svg)](https://www.npmjs.com/package/herdrchat)
[![license](https://img.shields.io/npm/l/herdrchat.svg)](https://github.com/zhangxiangliang/herdrchat/blob/main/LICENSE)

</div>

herdr-app 官方有手机端和电脑端。但想在外面用，手机得能连到跑 hc 的机器，
所以要先折腾 VPN 或内网环境；而且在手机的小屏幕上和 agent 交互，体验并不好。

飞书本来就在你手机上。herdrchat 自己主动连到飞书，网络上什么都不用配：不要公网 IP，也不要 VPN。
每个终端就是一个飞书群：agent 干活时说的话实时可见，它问你的问题点按钮就能回答，
图片双向都能传，所有终端汇总在一张总览卡片上。只有 agent 需要你、或者做完的时候手机才会响。
hc 能跑的 agent 都能用，我们自己用下来非常顺畅。

先支持飞书。后面有精力的话，也会考虑接入 Slack、Discord、Telegram 等其他聊天软件。

## 安装

```bash
npx skills add zhangxiangliang/herdrchat   # 给 agent 用的 skill（选 Symlink）
npm install -g herdrchat                   # skill 要用到的 herdrchat 命令
```

然后对你的 agent 说：

| 命令 | 做什么 |
|---|---|
| `/herdrchat setup` | 和你一起从零配好：飞书应用、配置、第一次启动。 |
| `/herdrchat status` | 告诉你它在不在跑，有问题的话问题在哪。 |
| `/herdrchat fix` | 找出问题的原因并修好。 |
| `/herdrchat config` | 改配置：接哪些终端、哪些群保持安静、标签。 |
| `/herdrchat feishu <任务>` | 替你在飞书开发者后台完成操作。 |

不用 agent 也可以直接在命令行里用：`herdrchat init`、`start`、`stop`、`status`、`logs`。

## 文件在哪

配置在 `~/.config/herdrchat/default/config.env`，bot 写的东西都在 `~/.local/state/herdrchat/default/`。
更新或重装 herdrchat 都不会动它们。

工作原理和全部配置：[docs/guide.md](docs/guide.md)（英文）。

## 许可证

MIT © [zhangxiangliang](https://github.com/zhangxiangliang)
