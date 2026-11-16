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
   leave `HERDR_SESSIONS` empty for hc's default session, or name others
   (`ls ~/.local/state/herdr-core` lists the sessions).
3. **Topic mode, checked before the first start.** It is not in BotFather's `/mybots` →
   Bot Settings list; it is in BotFather's mini app (the **Open** button at the bottom
   left of the BotFather chat): pick the bot, turn on Threaded Mode. Check it without
   printing the token: a short `node -e` reads the token from the config, calls
   `https://api.telegram.org/bot<token>/getMe` and prints only `username` and
   `has_topics_enabled`, which must be `true`.
4. **Start, then pair the owner.** Read the config (secrets hidden) in one step, then
   `herdrchat start P` in the next. Then run `herdrchat pair P` in the background: it
   prints a 6-digit code and waits. Tell the user the code; they open the bot (tap
   Start), send it, and the bot writes `TELEGRAM_OWNER_ID` itself and starts again as
   theirs. Until then the bot makes no topic. No id to copy.
5. **The topics.** One topic per tab appears; Telegram takes about one
   message a second in a chat, so twenty tabs take twenty seconds. A new topic gets the
   conversation before it (`HERDR_HISTORY`); `/history` in a topic posts it again.
6. **Make it a service.** Once it works: `herdrchat install P`. It then starts at login
   and comes back by itself after a crash, whatever happens to the hc cores;
   `herdrchat status P` says it runs as the service.

## What rings

The same settings as Feishu, in the Telegram profile's own config.env:

- "⚠️ needs you" and "✅ done" ring by sending the overview anew in the bot's own topic,
  `📋 herdr`, what rang under "waiting for you", just below its title (a "done" only in
  the overview that rings for it; a "needs you" until answered; one line each: topic, state, the
  time and its first line); the overview before it is edited into the record of what it
  rang for (never deleted), each note in full and "handled" once dealt with. Below,
  each machine lists its spaces and tabs the same way (Telegram has no tables). "done" (and "needs you" while the user is in that topic) waits `HERDR_DONE_WAIT`
  seconds (60) and rings nothing if the user wrote in that topic, or the terminal moved
  on, meanwhile (docs/guide.md, "What rings: the overview, sent anew").
- `HERDR_MUTED_SPACES` (default `all`): in these spaces posts go silently (a notification
  without sound), so only the overview rings. Elsewhere every post rings too.
- `HERDR_SILENT_SPACES` (default none): nothing rings there, not even
  "needs you".

A bot cannot mute a chat or a topic for the user. Muting the bot's whole chat in Telegram
mutes the overview too; `HERDR_SILENT_SPACES` quiets a whole space without that.

## What Telegram does differently

| Feishu | Telegram, and what stands in |
|---|---|
| a group per tab | a topic per tab, in the bot's private chat |
| an ended group gets the "herdr-ended" tag | an ended topic's name starts with 🔚 (closing a topic is documented for supergroups only) |
| an image inside a card | each image as its own photo after the text |
| a text box on a dialog card | type the answer in the topic |
| puts the group that needs you on top of the overview | pins the dialog card in its topic until it is answered |
| tags, labels, `/auth` | none (a bot cannot act as the user) |
| the direct chat | a topic of the bot's own, `📋 herdr` (made at the first start, again if deleted): the overview, its records, the commands and their answers; outside any topic they would be lost in "All Messages". The user can pin it; a bot cannot |
| `/` commands: typed | `/` shows a menu: ls, new, kill, screen, answer, esc, history |

## When something is off

| Seen | Cause | Do |
|---|---|---|
| log: `topic mode is off for @<bot>` | step 3 not done | turn it on in BotFather's mini app, check `has_topics_enabled`, start again |
| the bot answers "This bot has no owner yet" | `TELEGRAM_OWNER_ID` empty | step 4: `herdrchat pair P` |
| `herdrchat start` says it did not reach its chat app | wrong token, or no network | check with getMe (step 3) |
| log: `telegram poll: ... 409` | another copy polls the same token | `herdrchat stop P`, find the other one (another machine?), start once |
| log: `too fast, waiting N s` | Telegram's flood limit; the bot waits as told | nothing; it catches up |
| a click answers "This dialog is gone" | the card is older than the last 300 dialog cards | answer the newest card, or in the terminal |
