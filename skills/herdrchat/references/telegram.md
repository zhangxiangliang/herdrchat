# Telegram: the bot, from @BotFather to the first topic

A Telegram bot cannot make groups (the Bot API has no such method), so herdrchat puts each
herdr-app tab in a **topic** of your private chat with the bot: each has its own name,
icon color (one per space), unread count, and can be muted on its own. The chat's main
thread holds the overview and the commands. When Telegram is the only chat app, it uses
the default profile; beside a Feishu bot it gets its own (`--profile telegram`), and both
follow the same hc terminals, so an answer in either reaches the terminal and a dialog
answered in one closes its card in the other. Below, `P` is ` --profile <name>` when it
has its own profile, else nothing.

## Setup (`/herdrchat telegram setup`)

Do these in order; the user does the Telegram steps, you check each one.

1. **The bot.** The user messages **@BotFather**: `/newbot`, a name, a username ending in
   `bot`. BotFather answers with a token. The user keeps it: never ask them to paste it
   into the chat.
2. **The config.** `herdrchat init --chat telegram P` makes the profile's `config.env`
   (private) and prints where it is. Ask the user to paste the token after
   `TELEGRAM_BOT_TOKEN=` themselves (`open -e <file>` opens it), no quotes, no spaces, and
   fill `HERDR_SESSIONS` with them (`ls ~/.local/state/herdr-core` lists the sessions).
3. **Topic mode, checked before the first start.** It is not in BotFather's `/mybots` →
   Bot Settings list; it is in BotFather's mini app (the **Open** button at the bottom
   left of the BotFather chat): pick the bot, turn on Threaded Mode. Check it without
   printing the token: a short `node -e` reads the token from the config, calls
   `https://api.telegram.org/bot<token>/getMe` and prints only `username` and
   `has_topics_enabled`, which must be `true`.
4. **First start, to learn the owner.** `herdrchat start P`; the user messages the bot
   anything; it answers with the line to add, `TELEGRAM_OWNER_ID=<digits>`, and where the
   file is. The user adds it. Until then the bot makes no topic.
5. **Start again.** Read the config (secrets hidden) in one step, then
   `herdrchat start P` in the next. One topic per tab appears; Telegram takes about one
   message a second in a chat, so twenty tabs take twenty seconds. A new topic gets the
   conversation before it (`HERDR_HISTORY`); `/history` in a topic posts it again.
6. **Make it a service.** Once it works: `herdrchat install P`. It then starts at login
   and comes back by itself after a crash, whatever happens to the hc cores;
   `herdrchat status P` says it runs as the service.

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
| pins the group that needs you | pins the dialog card in its topic until it is answered |
| tags, labels, `/auth` | none (a bot cannot act as the user) |
| the overview card | one message in the main thread, edited in place |
| `/` commands: typed | `/` shows a menu: ls, new, kill, screen, answer, esc, history |

## When something is off

| Seen | Cause | Do |
|---|---|---|
| log: `topic mode is off for @<bot>` | step 3 not done | turn it on in BotFather's mini app, check `has_topics_enabled`, start again |
| the bot answers "To make you this bot's owner…" | `TELEGRAM_OWNER_ID` empty | step 4 |
| `herdrchat start` says it did not reach its chat app | wrong token, or no network | check with getMe (step 3) |
| log: `telegram poll: ... 409` | another copy polls the same token | `herdrchat stop P`, find the other one (another machine?), start once |
| log: `too fast, waiting N s` | Telegram's flood limit; the bot waits as told | nothing; it catches up |
| a click answers "This dialog is gone" | the card is older than the last 300 dialog cards | answer the newest card, or in the terminal |
