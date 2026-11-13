# Telegram: setting up the bot

A Telegram bot cannot make groups, so herdrchat puts each herdr-app tab in a topic of
your private chat with the bot; the chat's main thread is the overview and the commands
(`/ls`, `/new`, `/kill`; in a topic `/screen`, `/answer`, `/esc`). Posts are silent;
"needs you" and "done" ring.

It runs as its own profile, beside a Feishu one:

1. In Telegram, message **@BotFather**: `/newbot`, pick a name and a username, and keep
   the token it gives. Never paste the token into a chat or a log.
2. Turn on topics for the bot in @BotFather (its mini app, "Open": the bot's settings,
   Threaded Mode). Check: `getMe` answers `has_topics_enabled: true`.
3. Make the profile's config: `herdrchat init --profile telegram`, then in
   `~/.config/herdrchat/telegram/config.env` set `HERDRCHAT_CHAT=telegram`, the token as
   `TELEGRAM_BOT_TOKEN`, and `HERDR_SESSIONS`.
4. `herdrchat start --profile telegram`, then message the bot once: it answers with your
   `TELEGRAM_OWNER_ID=...`. Put that in the config and start it again. The topics appear,
   one per tab (Telegram allows about one message a second, so many tabs take a moment).

Check the token without printing it: read `TELEGRAM_BOT_TOKEN` from the config in a short
`node -e`, call `https://api.telegram.org/bot<token>/getMe`, print only `username` and
`has_topics_enabled`.
