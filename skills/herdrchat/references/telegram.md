# Telegram: the bot, from @BotFather to the first topic

A Telegram bot cannot make groups (the Bot API has no such method), so herdrchat puts each
herdr-app tab in a **topic** of your private chat with the bot: each has its own name,
icon color (one per space), unread count, and can be muted on its own. The chat's main
thread holds the overview and the commands. It runs as its **own profile**, beside a
Feishu one; each bot follows the same hc terminals, so an answer in either reaches the
terminal, and a dialog answered in one closes its card in the other.

## Setup (`/herdrchat telegram setup`)

Do these in order; the user does the Telegram steps, you check each one.

1. **The bot.** The user messages **@BotFather**: `/newbot`, a name, a username ending in
   `bot`. BotFather answers with a token. The user keeps it: never ask them to paste it
   into the chat.
2. **Topic mode.** It is not in BotFather's `/mybots` → Bot Settings list; it is in
   BotFather's mini app (the **Open** button at the bottom left of the BotFather chat):
   pick the bot, turn on Threaded Mode / topics. Check it (step 5): `has_topics_enabled`
   must be `true`, or no topic can be made.
3. **The profile's config.** Make `~/.config/herdrchat/telegram/config.env` (folder mode
   700, file 600) with:
   ```
   HERDRCHAT_CHAT=telegram
   TELEGRAM_BOT_TOKEN=
   TELEGRAM_OWNER_ID=
   HERDR_SESSIONS=<the same sessions as the Feishu profile>
   ```
   and ask the user to paste the token after `TELEGRAM_BOT_TOKEN=` themselves
   (`open -e <file>` opens it), no quotes, no spaces.
4. **First start, to learn the owner.** `herdrchat start --profile telegram`; the user
   messages the bot anything; it answers `TELEGRAM_OWNER_ID=<digits>`. The user puts that
   in the config. Until then the bot makes no topic.
5. **Check, without printing secrets.** In a short `node -e`: read the token from the
   config, call `https://api.telegram.org/bot<token>/getMe`, print only `username` and
   `has_topics_enabled`; for the owner, print only whether `TELEGRAM_OWNER_ID` is digits.
6. **Start again.** Read the config (secrets hidden) in one step, then
   `herdrchat start --profile telegram` in the next. One topic per tab appears; Telegram
   takes about one message a second in a chat, so twenty tabs take twenty seconds. A new
   topic gets the conversation before it (`HERDR_HISTORY`); `/history` in a topic posts it
   again.
7. **Make it a service.** Once it works: `herdrchat install --profile telegram`. It then
   starts at login and comes back by itself after a crash, whatever happens to the hc
   cores; `herdrchat status --profile telegram` says it runs as the service.

## What rings

The same settings as Feishu, in the Telegram profile's own config.env:

- `HERDR_MUTED_SPACES` (default `all`): in these spaces posts go silently (a notification
  without sound) and only "⚠️ needs you" and "✅ done" ring, as a short reply. Elsewhere
  every post rings.
- `HERDR_SILENT_SPACES` (default none): nothing rings there, not even "needs you".

A bot cannot mute a chat or a topic for the user. A topic the user mutes in Telegram is
fully quiet, "needs you" included; `HERDR_SILENT_SPACES` does the same for a whole space
without muting each topic by hand.

## What Telegram does differently

| Feishu | Telegram, and what stands in |
|---|---|
| a group per tab | a topic per tab, in the bot's private chat |
| an ended group gets the "ended" tag | an ended topic's name starts with 🔚 (closing a topic is documented for supergroups only) |
| an image inside a card | each image as its own photo after the text |
| a text box on a dialog card | type the answer in the topic |
| tags, labels, pins, `/auth` | none (a topic cannot be pinned; a bot cannot act as the user) |
| the overview card | one message in the main thread, edited in place |
| `/` commands: typed | `/` shows a menu: ls, new, kill, screen, answer, esc, history |

## When something is off

| Seen | Cause | Do |
|---|---|---|
| log: `topic mode is off for @<bot>` | step 2 not done | turn it on in BotFather's mini app, check `has_topics_enabled`, start again |
| the bot answers `Owner is not set` | `TELEGRAM_OWNER_ID` empty | step 4 |
| `herdrchat start` says it did not reach its chat app | wrong token, or no network | check with getMe (step 5) |
| log: `telegram poll: ... 409` | another copy polls the same token | `herdrchat stop --profile telegram`, find the other one (another machine?), start once |
| log: `too fast, waiting N s` | Telegram's flood limit; the bot waits as told | nothing; it catches up |
| a click answers "This dialog is gone" | the card is older than the last 300 dialog cards | answer the newest card, or in the terminal |
