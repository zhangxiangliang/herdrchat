# Feishu: the bot's app in the developer console

herdrchat's Feishu bot has settings that live in Feishu, not in this repo; they are
changed in the Feishu developer console (`https://open.feishu.cn/app`). This reference does
that with ego-browser, in the user's own logged-in browser.

## Before anything

1. **ego-browser, or the guide.** Only Feishu needs this (Telegram's bot is made in a
   chat, with no browser). Run `command -v ego-browser`. When it is there, run
   `ego-browser skill` and follow its usage guide. When it is missing, do not fall back
   to another browser; ask the user which they want:
   - **Install Ego Lite**, so the agent does the clicking. Use Ego's own instructions,
     read now at https://lite.ego.app/ (not from memory): say what it installs, and
     install only on a yes. Then check `command -v ego-browser` again (a new folder may
     need a new shell), and have the user sign in to Feishu in Ego as an admin of the
     tenant. If any of it fails or the user stops, take the guide below; do not retry
     other ways.
   - **The guide** ("Guide mode" below): the user clicks, the agent says what to click.
   Either way is the same procedures. When Ego stops working in the middle (signed out,
   a page that does not match), say so and go on in guide mode from that step: what is
   done stays done.
2. **Which profile.** Ask which Ego profile is signed in to Feishu as an admin of the
   tenant that owns the app (`await profiles()` lists them); never guess. Create one task
   space for the whole job with that `profileId`, and close it at the end with
   `await task.finish({ keep: [] })`.
3. **Which app.** The app id is `FEISHU_APP_ID` in the profile's `config.env`
   (`~/.config/herdrchat/<profile>/config.env`, or in `HERDRCHAT_HOME`). Read only that
   key; never print, screenshot or paste `FEISHU_APP_SECRET`, and never write a real app
   id, open_id, chat id or tenant name into a file of this repo. With Ego too, the agent
   does not read or reveal the secret on the credentials page: the user copies it into
   `config.env` themselves (the agent says the file and the line).
4. **Ask first** before anything outward-facing: publishing a version, applying scopes,
   deleting or deactivating an app. One yes covers one action.

## Guide mode (no Ego)

The same procedures, done by the user. Give one step at a time, with the page link and
the exact button text as Feishu shows it (the Chinese labels below), and wait for the
user to say it is done before the next step. Where a procedure says to check something
(the confirm list, 已开通, 已发布), ask the user what the page shows. Never ask the user
to paste the app secret into the chat.

## Pages

| What | URL |
|---|---|
| Basic info, icon, credentials | `https://open.feishu.cn/app/<APP_ID>/baseinfo` |
| Add capabilities (bot) | `https://open.feishu.cn/app/<APP_ID>/capability` |
| Scopes | `https://open.feishu.cn/app/<APP_ID>/auth` |
| Events and callbacks | `https://open.feishu.cn/app/<APP_ID>/event` (`?tab=callback` for callbacks) |
| Versions and publishing | `https://open.feishu.cn/app/<APP_ID>/version` |

The console is a slow single-page app: after `goto` or a click, wait (2-3 s, or
`waitForFunction` on the text you expect) before reading it. Find buttons by their
visible text with `page.evaluate` (`[...document.querySelectorAll("button")]`), not by
position: the layout shifts when a banner appears. Take a screenshot before each click
that applies or publishes something, and read it.

## Procedures

### Create the app (first setup only)

Developer console home -> create a custom app (企业自建应用) with a name, a description
and an icon -> Add capabilities -> Bot. Then import the scopes, have the user fill
`config.env` (`herdrchat init`), start the bot (`herdrchat start`: the long-connection
check below needs it running), set events and callbacks, and publish. "Set up: Feishu"
in `docs/guide.md` lists the same steps from the user's side.

### Import scopes

Scopes page -> 批量处理 -> 批量导入/导出权限. Paste the JSON from "Scopes this bot uses"
below (only the ones still missing is fine; the dialog skips what is there).

- **Click inside the editor's text first, then select all and replace.** Pressing
  select-all before the editor has focus selects the whole page, and the import then
  submits the editor's default sample (`docx:document:readonly`) instead of yours.
- Read the editor back before going on: the lines are in `.view-lines .view-line`.
- Next step (下一步，确认新增权限) opens a confirm dialog listing the scopes it will add,
  by their Chinese names, split into bot (应用身份) and user (用户身份) tabs. Check that
  list matches what you meant to add, then (after the user's yes) 申请开通.
- Verify on the scopes page that each one reads 已开通. Most of these are review-free
  and live at once; the page header then still says 当前修改均已发布. When it says
  版本发布后，当前修改方可生效 instead, publish a version.
- Unknown scope names are dropped silently, so a missing one in the confirm list means
  a typo or a scope that does not exist.

### Events and card callbacks

Both must use the long connection (长连接), which needs the bot running.

- Events (事件配置): subscription mode -> long connection; add `im.message.receive_v1`.
- Callbacks (回调配置): edit the subscription mode -> 使用长连接接收回调 -> 验证 (it must
  answer 连接成功; if not, the bot is not running) -> 保存 -> 添加回调 -> card ->
  `card.action.trigger` (not the old `card.action.trigger_v1`, which cannot use the long
  connection) -> 添加. Without it, a click on a dialog button fails with error 200340.
- Publish a version afterwards.

### Publish a version

Versions page -> 创建版本 (the form loads slowly; wait for the 保存 button). Check the
version number (one above the last) and that the green bar says 本次发布免审核; if it
does not, the version goes to the tenant admin for review - tell the user. 保存 ->
确认发布 -> reload the versions page and check the new version reads 已发布.

### Change the app icon (the bot's avatar)

Basic info -> the edit pen next to 综合信息 -> `page.setInputFiles("input[type=file]",
[<absolute path>])` with a square JPEG/PNG/SVG/BMP over 240x240 px, under 2 MB, without
rounded corners -> 保存 in the crop dialog -> 保存 under the form. Then publish a
version; the client may need a while or a restart to show it.

### Delete an app

The developer console's delete button stays disabled while the app is enabled.
Deactivate it first in the tenant admin console,
`https://<tenant>.feishu.cn/admin/appCenter/manage/<APP_ID>` (needs a tenant admin),
then delete it in the developer console. Ask before each of the two steps.

### The bot menu (optional)

A menu at the bottom of the direct chat with the bot, so the commands are a tap away as
Telegram's "/" list is. Feishu sets it only in the developer console (no API), shows it
in the direct chat only (not in groups), and needs a published version (then about five
minutes, and a client of 5.27 or later).

1. 应用能力 -> 机器人 -> 机器人自定义菜单: edit, turn it on (开启), pick a style.
2. Add items whose action is 推送事件 (push an event), with these keys; the bot treats a
   click as that command in the direct chat:
   | Item | Event key |
   |---|---|
   | Overview | `ls` |
   | Help | `help` |
   | Act as me | `auth` |
3. 事件与回调 -> 事件配置 (long connection mode, as for messages) -> 添加事件:
   机器人自定义菜单事件 (`application.bot.menu_v6`).
4. Publish a version. Ask before publishing.

Commands that take words (`/new`, `/kill`) stay typed.

## Scopes this bot uses

Bot identity (the bot itself) and user identity (only for `/auth`, acting as the user):

```json
{
  "scopes": {
    "tenant": [
      "im:message:send_as_bot",
      "im:message.p2p_msg:readonly",
      "im:message.group_msg",
      "im:message:readonly",
      "im:message.reactions:write_only",
      "im:resource",
      "im:chat:create",
      "im:chat:update",
      "im:tag:write",
      "im:biz_entity_tag_relation:write"
    ],
    "user": [
      "im:chat.user_setting:write",
      "im:feed_group_v1:read",
      "im:feed_group_v1:write",
      "im:feed.shortcut:write",
      "offline_access"
    ]
  }
}
```

What each is for is in `docs/guide.md` ("Set up" and "Optional: let the bot act as you").
A scope the code does not call is not added.

## Traps seen

- Select-all before the editor has focus selects the page (see Import scopes).
- A button found by position moved under a banner; find it by its text.
- `evaluate` on the version form ran before it loaded and found no 保存; wait for it.
- The callback "verify" fails when the bot is not running; start it first.
- Changes on the scopes page that need a version say so in the header; review-free
  scopes do not, and publishing for them is not needed.
