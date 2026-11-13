# Contributing to herdrchat

Thank you for helping. This page is for working on herdrchat's code; using it is in the
README and `docs/guide.md`.

## The code

`docs/architecture.md` says where everything is and how to add a chat app or an agent
(a reader). In short: the core (`lib/core/engine.mjs`) knows no chat app; each app is a
folder in `lib/chats/` behind the contract in `lib/chats/contract.mjs`, checked at start.

```bash
git clone https://github.com/zhangxiangliang/herdrchat.git && cd herdrchat
npm install
npm test                 # every test, the core on a fake chat app and a fake hc
node bin/cli.mjs status  # the command line from the clone
```

Try a change in its own folder, never next to your real bot: with `HERDRCHAT_HOME` set to
a new folder, a setup gets its own hc terminal and service name.

`sh scripts/smoke.sh local` walks the user's way in for real, in a throwaway home: the
packed package installed, the skill installed by the `skills` tool, `init`, `status` and
`start` saying what is missing. CI runs it on every push and before every release, and
every day on what is published (`.github/workflows/published.yml`), so a broken install
is found by us, not by a user. `test/docs.test.mjs` checks that every link and command
in the docs exists.

A change to what the core does gets a test in `test/engine.test.mjs` (`test/fakes.mjs`
has the fake chat app, hc and reader). A chat app gets a test that `checkChat` passes.

## Commits and releases

Commit messages follow Conventional Commits; the body says why. A push to `main` releases
by itself (semantic-release with npm trusted publishing): `fix:` makes a patch release,
`feat:` a minor one; `docs:`, `ci:`, `refactor:`, `chore:` and `test:` release nothing.

Before a commit:

1. `npm test` passes.
2. Nothing personal or private is staged: no real session or machine names, app ids,
   tokens, open_ids (`ou_`), chat ids (`oc_`), message ids (`om_`), people's names or
   local paths. Scan the staged files as its own step and read the result before
   committing.

## Did a change take effect

Check the live result, not only the code: count what actually happened in Feishu with
the bot's own client (`lib/chats/feishu/client.mjs` `createClient` with `loadConfig()`), for example:

- mentions in a group since a time: `im.v1.message.list` on the chat, then each item's
  `mentions` (a mention inside a card is not counted by Feishu, so it does not ring);
- a group's bot tags: `im.v2.bizEntityTagRelation.get` with `tag_biz_type: 'chat'`;
- whether a card was edited: `im.v1.message.get`, compare `update_time` with `create_time`.

Say which checks were run and which were not; "the code is there" is not "it works".


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

