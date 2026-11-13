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
