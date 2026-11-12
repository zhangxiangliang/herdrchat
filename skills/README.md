# Skills

`herdrchat/` is the one skill: an agent that reads `SKILL.md` (Claude Code and others) uses
it to set up, run and look after herdrchat. Its commands are `/herdrchat <command>`.

Each part of the system has one reference under `herdrchat/references/`, named after the
part: a chat app (`feishu.md`, later `slack.md`, `discord.md`, `telegram.md`) or a part of
the core (`ops.md`, later `reader.md`). New work goes into the reference of its part, or
a new one for a new part; `SKILL.md` only lists commands and points to references.
