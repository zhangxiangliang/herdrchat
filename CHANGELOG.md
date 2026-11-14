# [1.11.0](https://github.com/zhangxiangliang/herdrchat/compare/v1.10.2...v1.11.0) (2026-11-14)


### Features

* tell when a newer herdrchat is out, and update it from the chat or a terminal ([1d72302](https://github.com/zhangxiangliang/herdrchat/commit/1d723028befdd654859c55b7b15ace19e56a7384))

## [1.10.2](https://github.com/zhangxiangliang/herdrchat/compare/v1.10.1...v1.10.2) (2026-11-14)


### Bug Fixes

* post the screen when a message you sent left nothing in the agent's records ([1a7dfd8](https://github.com/zhangxiangliang/herdrchat/commit/1a7dfd8fbba846d646b396ef79e568d6b893ca3c))

## [1.10.1](https://github.com/zhangxiangliang/herdrchat/compare/v1.10.0...v1.10.1) (2026-11-14)


### Bug Fixes

* call Claude Code "claude" in the footer, and fill it in after a restart ([cc6bf10](https://github.com/zhangxiangliang/herdrchat/commit/cc6bf10f6e75b4b39fcd0cb30fcfa62a0fcc5c50))

# [1.10.0](https://github.com/zhangxiangliang/herdrchat/compare/v1.9.0...v1.10.0) (2026-11-14)


### Features

* show the branch, context, and 5-hour and 7-day limits under each post ([3123a90](https://github.com/zhangxiangliang/herdrchat/commit/3123a900ab84eba4a263f57b50bb6c6d25746318))

# [1.9.0](https://github.com/zhangxiangliang/herdrchat/compare/v1.8.1...v1.9.0) (2026-11-14)


### Features

* say under each post which harness and model it came from ([a17f23c](https://github.com/zhangxiangliang/herdrchat/commit/a17f23cc92dace37350aca7c01639a3238452e0f))

## [1.8.1](https://github.com/zhangxiangliang/herdrchat/compare/v1.8.0...v1.8.1) (2026-11-14)


### Bug Fixes

* show marks in overview names without a backslash ([6b7368d](https://github.com/zhangxiangliang/herdrchat/commit/6b7368dfdba095589b8dbf57bc0e2a16c345d42c))

# [1.8.0](https://github.com/zhangxiangliang/herdrchat/compare/v1.7.0...v1.8.0) (2026-11-14)


### Features

* answer Codex's questions from its own log ([024c3a2](https://github.com/zhangxiangliang/herdrchat/commit/024c3a2b7829897029d4071e1e52aa2e1618c626))

# [1.7.0](https://github.com/zhangxiangliang/herdrchat/compare/v1.6.0...v1.7.0) (2026-11-14)


### Features

* answer Claude Code's and Codex's dialogs through their own hook ([b0077ba](https://github.com/zhangxiangliang/herdrchat/commit/b0077ba6e60f5777c0ab3074c93d268cf9cc2e73))

# [1.6.0](https://github.com/zhangxiangliang/herdrchat/compare/v1.5.0...v1.6.0) (2026-11-13)


### Bug Fixes

* give a card to a dialog that waited before the bot started, and keep it through a restart ([41a5c40](https://github.com/zhangxiangliang/herdrchat/commit/41a5c40b4ddd18a8dbea368aef5fd18909e89e69))


### Features

* read OpenCode through its own API: its conversation, its questions and permissions ([3793c12](https://github.com/zhangxiangliang/herdrchat/commit/3793c12641943fde6c174ce2b5ce3d897bdf017a))

# [1.5.0](https://github.com/zhangxiangliang/herdrchat/compare/v1.4.1...v1.5.0) (2026-11-13)


### Bug Fixes

* take a moment offline for what it is, not for a revoked /auth ([9998825](https://github.com/zhangxiangliang/herdrchat/commit/9998825c6d1a9b4a4d1af0af9fc2dcf88c9f5450))


### Features

* give Feishu cards Feishu's own icons, buttons that fit their words, and state tags ([954e716](https://github.com/zhangxiangliang/herdrchat/commit/954e716088a0bfedfec15cd1b2d228008397f616))
* read Codex as fully as Claude Code: its log, its approvals, its room name ([16b945e](https://github.com/zhangxiangliang/herdrchat/commit/16b945ef91c31b258209ef33be0fa04097ab411a))

## [1.4.1](https://github.com/zhangxiangliang/herdrchat/compare/v1.4.0...v1.4.1) (2026-11-13)


### Bug Fixes

* tell you when a message cannot be passed on, instead of dropping it ([baed7f5](https://github.com/zhangxiangliang/herdrchat/commit/baed7f57cd71da2352cec6c6072f7048e49a3cd9))

# [1.4.0](https://github.com/zhangxiangliang/herdrchat/compare/v1.3.3...v1.4.0) (2026-11-13)


### Bug Fixes

* never leave a dialog with no card to answer ([d74cfdd](https://github.com/zhangxiangliang/herdrchat/commit/d74cfdd51176edc059e26c15bceb55eefe229cdf))
* tick a multi-select on the Feishu card with no loading, and keep a dialog's key through a resize ([00c3635](https://github.com/zhangxiangliang/herdrchat/commit/00c36350b6dd90de8ef69c99eaa076c1f8ebcf9f))


### Features

* set herdrchat up by answering a few questions, and pair the owner by code ([5654505](https://github.com/zhangxiangliang/herdrchat/commit/5654505e54ad678c3f933d111504b91a901ea977))

## [1.3.3](https://github.com/zhangxiangliang/herdrchat/compare/v1.3.2...v1.3.3) (2026-11-13)


### Bug Fixes

* say up front that herdrchat is built on herdr and needs it ([30760a8](https://github.com/zhangxiangliang/herdrchat/commit/30760a871a53bdb1dbe2d6169adbb869c1ce4f74))

## [1.3.2](https://github.com/zhangxiangliang/herdrchat/compare/v1.3.1...v1.3.2) (2026-11-13)


### Bug Fixes

* quote the skill's description so its YAML header parses ([655710c](https://github.com/zhangxiangliang/herdrchat/commit/655710c878340526201d5da8a78451d7064fe6de))

## [1.3.1](https://github.com/zhangxiangliang/herdrchat/compare/v1.3.0...v1.3.1) (2026-11-13)


### Bug Fixes

* make herdrchat safe and plain for a first-time user ([7c0c946](https://github.com/zhangxiangliang/herdrchat/commit/7c0c946f53a82175ac10edcec18b7900936d461b))

# [1.3.0](https://github.com/zhangxiangliang/herdrchat/compare/v1.2.1...v1.3.0) (2026-11-13)


### Bug Fixes

* wait a minute for the chat app at start, and log a library's errors as warnings ([8cf676d](https://github.com/zhangxiangliang/herdrchat/commit/8cf676dcf60463b469078b22a4f34d6366e32a34))


### Features

* align Feishu and Telegram: pin the waiting card in Telegram, take Feishu's bot menu ([5a4a04f](https://github.com/zhangxiangliang/herdrchat/commit/5a4a04fd92a8d8152b8c193a957d6570965d05fe))

## [1.2.1](https://github.com/zhangxiangliang/herdrchat/compare/v1.2.0...v1.2.1) (2026-11-13)


### Bug Fixes

* hold a message sent while a dialog waits, and never drop it ([a1924cd](https://github.com/zhangxiangliang/herdrchat/commit/a1924cd3ddceca787f78272ae225e8bc20cb6f80))
* never lose a message: keep held ones, catch up on Feishu, say where none goes ([1b8871e](https://github.com/zhangxiangliang/herdrchat/commit/1b8871eb8f98a6e0baff7456339e28af0d0f4ff1))

# [1.2.0](https://github.com/zhangxiangliang/herdrchat/compare/v1.1.2...v1.2.0) (2026-11-13)


### Bug Fixes

* keep Telegram's dialog buttons across a restart ([c210173](https://github.com/zhangxiangliang/herdrchat/commit/c2101736efee28f4284f5d1d9605143acdb8845c))
* pick an option in a question with previews by the arrows and Enter ([4742f0c](https://github.com/zhangxiangliang/herdrchat/commit/4742f0c6c21b6cd06322a032bca22573e26cb8ea))


### Features

* run herdrchat as a service that starts at login and comes back after a crash ([b6b4450](https://github.com/zhangxiangliang/herdrchat/commit/b6b445027a738fd19d70f9a6d94f057a504c5b72))
* show a message another terminal sent with hc send as from that terminal ([2bc3b7a](https://github.com/zhangxiangliang/herdrchat/commit/2bc3b7af2c6e8d15a2523d53737f835f10b94f9f))

## [1.1.2](https://github.com/zhangxiangliang/herdrchat/compare/v1.1.1...v1.1.2) (2026-11-13)


### Bug Fixes

* card the dialog that waits, as drawn, and quiet Telegram by the settings ([66abb59](https://github.com/zhangxiangliang/herdrchat/commit/66abb59df3ffcadbf79502382648b81a328dc247))

## [1.1.1](https://github.com/zhangxiangliang/herdrchat/compare/v1.1.0...v1.1.1) (2026-11-13)


### Bug Fixes

* tick multi-select boxes on the card and send them on Next ([8ac9282](https://github.com/zhangxiangliang/herdrchat/commit/8ac9282a4d0cdf71308468244858aa1b6a5b35af))

# [1.1.0](https://github.com/zhangxiangliang/herdrchat/compare/v1.0.0...v1.1.0) (2026-11-13)


### Bug Fixes

* follow each terminal once, told apart by hc core ids ([fdd9a6d](https://github.com/zhangxiangliang/herdrchat/commit/fdd9a6dc9c117aadbd43959a58263f7285c16373))
* give a group its space's avatar again when the space changes ([cf88745](https://github.com/zhangxiangliang/herdrchat/commit/cf88745066a73f0c3e11dbd96065dc049ceb3692))
* mirror agents only, keep a tab's group, say plainly what failed ([2a80fe5](https://github.com/zhangxiangliang/herdrchat/commit/2a80fe5837520337443088c8720f3ced76b5df3c))
* never leave the bot silent: find hc, check the start, say when down ([dd83afa](https://github.com/zhangxiangliang/herdrchat/commit/dd83afafbe6c0bed56dd724660430f7d6c0385dd))
* wait quietly for an unreachable machine instead of logging every check ([602ac77](https://github.com/zhangxiangliang/herdrchat/commit/602ac770c960f89bc951c6ae3244a49066a3722c))


### Features

* give a new room the conversation before it ([cc5cd11](https://github.com/zhangxiangliang/herdrchat/commit/cc5cd110ec5b5f6c377a93f450ee3795ef6e14c5))
* mirror into Telegram, one topic per tab in the bot's private chat ([9c897f9](https://github.com/zhangxiangliang/herdrchat/commit/9c897f9b33dfa5ab8cb604166534732fc1bc3cfb))

# 1.0.0 (2026-11-12)


### Features

* herdrchat, every hc terminal in Feishu ([7c6833c](https://github.com/zhangxiangliang/herdrchat/commit/7c6833c96ce81521b044a5623933d101b6c5248d))
