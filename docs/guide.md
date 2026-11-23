# herdrchat guide

How herdrchat works and every setting, for when the README is not enough.

herdrchat is hc's chat client, as herdr-app is its desktop and phone client: every
tab an agent runs in, followed and answered in a chat app, Feishu or Telegram. It needs
hc alone; herdr-app is never run, and where it is used, the two go by the same labels. Both sit on the same core (hc events, a reader per agent,
dialogs, the overview), each behind one contract (`docs/architecture.md`); Slack and
Discord may follow the same way. A profile is one chat app (`HERDRCHAT_CHAT`); to use
both, run a profile each.

Words used here:

| Word | Meaning |
|---|---|
| hc, herdr-core | the program that runs terminals and keeps them alive ([herdr.dev](https://herdr.dev)) |
| herdr-app | its desktop and phone app, which shows the terminals in spaces and tabs |
| session | one hc core and its terminals (`HC_SESSION`); `ls ~/.local/state/herdr-core` lists those on a machine |
| space, tab | how herdr-app groups terminals in its sidebar |
| room | where one tab is mirrored: a Feishu group or a Telegram topic |
| direct chat | your private chat with the bot: the overview and the commands (Telegram: the bot's own topic, `📋 herdr`) |
| profile | one herdrchat setup for one chat app, with its own settings and state (`default` unless named) |
| reader | the part that reads an agent's own conversation log (Claude Code so far) |

## Feishu

herdr-app, moved into one Feishu bot:

| herdr-app | Feishu |
|---|---|
| a tab | a group named `<space> / <tab>`, tagged `herdr`; type there to talk to it |
| a space | one avatar for all of its groups: the space's first letter on a color of its own |
| a terminal on another machine | a group named `<space> / <tab>`, tagged `herdr`, made once |
| a terminal that is gone | its group stays, with its history; its tag `herdr` becomes `herdr-ended` (and back if it comes back) |
| the sidebar | the direct chat with the bot: an overview card (what is waiting for you first; then a heading per machine, this computer first, and a table of its tabs: Room, a link to its group; State, a colored tag; Latest, the time and the first line of what it last said; under them a ＋ New terminal button), kept up to date in place, sent anew when something rings; `/ls`, `/new`, `/kill`, `/usage` |

A tab herdr-app only numbered (`2`) is named after the terminal's title instead (what the
program sets; Claude Code sets its session name or topic), else its hc name.

Everything comes from hc, so it works the same for Claude Code, codex, pi or any program
hc shows, on this machine or on a machine hc has added. Nothing is installed in the agents.

## Telegram

A Telegram bot cannot make groups, so it uses topics in your private chat with the bot
(topic mode must be on: BotFather's mini app, the Open button in the BotFather chat, then
the bot, Threaded Mode):

| herdr-app | Telegram |
|---|---|
| a tab | a topic named `<space> / <tab>` in the bot's private chat; type there to talk to it |
| a space | one topic icon color for all of its topics (Telegram offers six) |
| a terminal that is gone | its topic stays, its name starting with 🔚 (taken off if it comes back) |
| the sidebar | a topic of the bot's own, `📋 herdr`, made at the first start: the overview message (with a ＋ New terminal button), edited in place, sent anew when something rings; `/ls`, `/new`, `/kill`, `/usage`; `/` shows the commands. Outside any topic it would land in "All Messages", mixed with every room's posts |

What differs is in "Feishu and Telegram side by side" below. Telegram takes about one
message a second in a chat, so the bot queues and waits as Telegram asks. Setting it up:
"Set up: Telegram" below.

## Feishu and Telegram side by side

Both do the same things; where an app cannot, something stands in.

| | Feishu | Telegram |
|---|---|---|
| a tab | a group | a topic in the bot's private chat |
| a space | an avatar (its letter, its color) | a topic icon color |
| an ended terminal | the `herdr-ended` tag | 🔚 before the topic's name |
| the direct chat | the overview card (sent anew when something rings), commands typed or from the bot menu (set in the console) | the `📋 herdr` topic: the overview, commands with the `/` list (one sent outside any topic is answered in `📋 herdr`; one Telegram made a new topic of is answered there). A topic you deleted is made again. Pin it in Telegram to keep it on top (a bot cannot; a new topic asks you to, once) |
| what it says while working | one live card per turn, edited | one live message per turn, edited |
| a dialog | a card with buttons, a text box for its own words | a message with buttons; its own words are typed in the topic |
| needs you | the overview sent anew, the group on top of it | the dialog card pinned in its topic, the overview sent anew |
| the overview | "waiting for you" and a table per machine, each Room / State / Latest | the same as lists: a line per note, a bullet per space and a line per tab, each with its topic (a link), state and latest |
| what rang | the card's summary (the lock screen) and the "waiting for you" table | the "waiting for you" lines, just under the title (a notification shows a message's first lines) |
| an overview a newer one replaced | edited into the record of what it rang for, in full, never recalled | edited into the record of what it rang for, in full, never deleted |
| quiet spaces (`HERDR_MUTED_SPACES`) | groups muted (after `/auth`); only the notes ring | posts silent; only the notes ring |
| silent spaces (`HERDR_SILENT_SPACES`) | nothing rings | nothing rings |
| a new room (`HERDR_HISTORY`), `/history` | the conversation as a file, its newest part in a folded panel | the same, the newest part in an expandable quote |
| images | in the card, both ways | as photos after the text, both ways |
| your message marked | a reaction, then OK | 👀, then 👌 |
| tags and labels (`HERDR_BOT_TAGS`, `HERDR_USER_TAGS`) | yes | none in Telegram |
| messages while the bot is away | looked for and handled when it connects | kept by Telegram for 24 hours, handled when it connects |
| acting as you (`/auth`) | mute, labels | not needed: posts are silent by themselves |

## Settings

In the profile's `config.env` (`herdrchat status` prints where it is):

| Key | For | Default | What it does |
|---|---|---|---|
| `HERDRCHAT_CHAT` | both | `feishu` | the chat app this profile mirrors into: `feishu` or `telegram` |
| `HERDR_SESSIONS` | both | `default` | the hc sessions to mirror, comma-separated; machines they reach come along. `default` is hc's own session, which with herdr-app reaches every session it shows |
| `HERDR_MUTED_SPACES` | both | `all` | spaces whose rooms are quiet, so only the overview in the direct chat rings; empty for none |
| `HERDR_SILENT_SPACES` | both | (none) | spaces that ring nothing at all, not even "needs you" |
| `HERDR_DONE_WAIT` | both | `60` | seconds a "done" waits before it rings (and a "needs you" while you are in that room); your message in its room, or the terminal moving on, meanwhile means you saw it and nothing rings. `0`: at once |
| `HERDR_HISTORY` | both | `file,folded` | what a new room gets of the conversation before it: `file`, `folded`, both, or empty |
| `HERDR_REDACT` | both | `on` | what goes to the chat app (and the log) is hidden where it looks like a secret; see "Secrets are hidden" below. `off`: nothing is |
| `HERDR_REDACT_WORDS` | both | (none) | words hidden too, comma-separated: a client's name, a codename |
| `FEISHU_APP_ID`, `FEISHU_APP_SECRET` | Feishu | (required) | the Feishu app |
| `FEISHU_OWNER_OPEN_ID` | Feishu | (empty) | you; the bot tells you yours when you message it |
| `HERDR_BOT_TAGS` | Feishu | `on` | one tag next to a group's name: `herdr` while its terminal lives, `herdr-ended` once it is gone |
| `HERDR_USER_TAGS` | Feishu | `on` | your sidebar labels, once `/auth` is done |
| `TELEGRAM_BOT_TOKEN` | Telegram | (required) | the bot's token from @BotFather |
| `TELEGRAM_OWNER_ID` | Telegram | (empty) | you; the bot tells you yours when you message it |

Where a profile's files are: settings in `~/.config/herdrchat/<profile>/config.env`,
what the bot writes (state, logs, your `/auth` token) in
`~/.local/state/herdrchat/<profile>/`; `herdrchat status` prints both.

In the environment (not `config.env`): `HERDRCHAT_PROFILE` (or `--profile`) picks the
profile; `HERDRCHAT_HOME` puts a profile's `config.env` and state in one folder of your
choice (give each profile its own); `XDG_CONFIG_HOME` and `XDG_STATE_HOME` move the usual
folders. A setup in a moved folder gets its own hc terminal and service name, so trying
one never touches the usual one. A key set in the environment wins over `config.env`. A
setting changed in `config.env` takes effect at the next `herdrchat start`.

## How it works: hc, plus a reader per agent

**hc is the backbone.** The bot follows `hc events --json` for each session (its format:
`hc schema`). From hc it learns which terminals exist, where
they are (labels), their status, and when a turn ends (`turn` event: the status left
`working`). Typing from a group goes through `hc send`, which holds a message while the
terminal's input box has a draft (hc's `draft_wait`, 60 s after the last key): past 10 s the
group is told it is held, and it goes in once the draft is done. Nothing else is run: herdr-app
is a client of hc as herdrchat is, and they meet only in hc's labels.

**Which terminals count, from hc alone.** A terminal with a `where` label (`<space> /
<tab>`: herdr-app writes it on every terminal it shows, the new-terminal form writes it
too) is where it says. One without it counts when no other terminal started it (hc's
`parent`: an agent's helpers have one) and an agent runs in it, named by its folder and
its title or hc name (`api / Fix the login`): `hc run claude` on a server with no
herdr-app gets its room. Either way a room is an agent's (below).

**A reader gives the conversation.** hc can show only the screen, and the screen is a
picture: long output is folded, and you cannot tell your words from the agent's. So for
each agent a reader reads the agent's own records. The status hc reports names the agent
(`status.app`), and that name picks the reader (`lib/core/readers/`):

| `status.app` | reader | reads |
|---|---|---|
| `claude-code` | `lib/core/readers/claude.mjs` | its transcript: the terminal's foreground pid names the session in `~/.claude/sessions/<pid>.json` |
| `codex` | `lib/core/readers/codex.mjs` | its rollout log in `~/.codex/sessions/`: the one written since the terminal's codex started, in its folder |
| `opencode` | `lib/core/readers/opencode.mjs` | its own API (`opencode api`): the folder's active session |
| `pi` | `lib/core/readers/pi.mjs` | its session log in `~/.pi/agent/sessions/--<folder>--/`: the newest written since the terminal's pi started (Pi runs in its own process group, so it is found as the shell's child) |
| anything else | none | nothing by itself; what you type gets its screen in reply |

On another machine, a reader reads the same files through `hc exec --on`. To add an
agent: `docs/architecture.md`, "Adding an agent".

## What a room shows

A room is a Feishu group or a Telegram topic.

- A program with a reader:
  - while it works: one "⌛️ Working…" card per turn (then "✅ Worked"), edited every 5
    seconds with what is new: what it says, your prompts (typed in the terminal or sent
    mid-turn) as **You:**, and each tool it calls as one line (`▸ Bash: Run the tests`),
    as it is (the `*`, `_` and `/` of a command are no marks).
    It shows the program is alive, as herdr-app does, and since an edit is not a new
    message, the phone does not ring every few seconds;
  - when the turn ends: its last answer, as a new message. Rooms ring nothing of their
    own in a space of `HERDR_MUTED_SPACES` (all, by default): Feishu groups are muted
    (after `/auth`), Telegram posts go silently. What rings is the overview, sent anew (below).
    `HERDR_SILENT_SPACES` rings nothing.
  - A message another terminal sent with `hc send` shows as **From t7 review**, not as
    yours (hc wraps it in `<hc from="…">`, for any agent).
  - Images too: ones it looked at (a screenshot, an image file it read) and ones you
    pasted in the terminal, shown in the card.
  - What you sent from the group is not repeated.
  - What the agent writes is its markdown: bold, italics (`*a*` or `_a_`), code, links,
    quotes, code blocks. Your words, what a dialog asks and a screen are shown as they
    are: their `*`, `_`, `<` and backticks are never read as marks. In Telegram a path
    (`/tmp/a.txt`, `~/notes`) is sent as code, so it is not a command to tap; the bot's
    own commands (`/ls`, `/new`, …) stay tappable.
  - Under each post and card, one small line says where it came from and how it stands:
    the harness hc names, the model the agent's own records name (or `screen` when it was
    read off the screen), the git branch of its folder, how full its context is, and the
    account's limits:
    `claude · claude-opus-5-5 · main · context 23% (234k) · 5-hour 2% · 7-day 57%`.
    herdrchat adds it, never the agent, and spends nothing on it: Codex writes all of it
    in its own log; Claude Code's window and limits come from `claude -p /context` and
    `claude -p /usage`, which Claude Code answers itself without asking a model (the
    limits at most every 5 minutes per machine); OpenCode's window from its model list,
    and on Zhipu's GLM Coding Plan (or Z.ai's) the plan's limits, asked the way Zhipu's own
    usage plugin asks them, with the key from OpenCode's own credentials (held only for
    that request, never written or logged, sent only to Zhipu). What is not known is left
    out: limits for an API key, a provider that names none, or a reading that fails.
  - `/usage` in the direct chat says every account at once, on this machine and every
    machine a session is connected to: Claude Code's (`claude auth status` and
    `claude -p /usage`), Codex's (its app server's `account/read` and
    `account/rateLimits/read`, live from OpenAI, as its own TUI asks them) and each GLM
    Coding Plan (or Z.ai) key in OpenCode's credentials or Pi's `auth.json`, with each
    limit's share used and when it resets:

    ```
    **Claude Code** (max) · me@example.com · on m1
    5-hour 2% · resets in 3h 24m
    7-day 67% · resets in 24m

    **Codex** (pro) · me@example.com · on m1
    7-day 70% · resets in 2d 2h

    **GLM Coding Plan** (max) · in OpenCode, Pi · on m1
    5-hour 17% · resets in 4h
    ```

    An account found on several machines (one login, or one key in two agents) is said
    once. Another hc core on this machine (the same host and home) is not asked again; a
    machine that is not connected is named under "Not reached". A sign-in whose agent
    names no limits (an API key, Claude Code's setup token) says so. Nothing asks a model.
- Anything else (a shell, a tool, an agent that has quit): nothing by itself. A terminal
  counts as an agent only while its foreground process is that agent, so a status left
  over after it quits posts nothing.
- A turn that ends on `blocked` (permission, question, auth): what it said first, then
  a red "⚠️ Needs you" card. When the screen shows a numbered menu (as Claude Code's
  permission and question dialogs do), the card shows only the dialog, as text, with a
  button per option; a multi-select also has "Next ⇥", a "Type something" option a box to
  type in (Feishu; in Telegram you type the answer in the topic), and every card "Esc".
  Without a menu the card shows the last lines of the screen and how to answer by typing.
  Once the dialog is gone the card turns to "✅ Done". A card is posted only for a dialog
  that still waits: one answered while its screen was read gets none.
- A turn that stops on an error with no answer (you declined OpenCode's tool, with Reject
  or Esc; Pi's request failed): a line saying it stopped and why, in the agent's words
  ("It stopped: The user declined this tool call"), and it rings as "done".

## What rings: the overview, sent anew

When a room needs you or its turn is done, it gets a note, and the overview in your direct
chat with the bot (Telegram: the `📋 herdr` topic) is sent anew at the bottom, which rings. It
shows first what rang ("waiting for you"), and the lock screen says it. With nothing new, the newest overview is
only edited, which does not ring.

The overview is for seeing everything at once, so in Feishu it is tables, each with the
same three columns:

| Column | What it holds |
|---|---|
| Room | the space and tab (`herdrchat / master`), a link that opens its group |
| State | a colored tag: needs you (orange; also while its card waits for you, whatever hc says), working (blue), done (green), error (red), idle (grey); an agent still starting, with no status yet, the program it runs |
| Latest | the time and the first line of what it last said: `11:49: Fixed it.` (cut to fit; a tap shows it whole) |

First "waiting for you" (what asks you something and is not answered yet; the overview
that rings for a "done" shows it there too, once), then a heading per machine ("This
computer" first, every session in `HERDR_SESSIONS` in one table; then each machine reached
over a link, by name) and its table, what needs you first: needs you, error, working, done, then idle;
within one state the one that spoke last first. A terminal with no agent (a shell, a
server such as `node`) is left out: it has nothing to tell you. (Telegram's lists order
their spaces and tabs the same way.) A room's latest is kept from what it says; one with none yet gets the last answer
in its agent's own records. A table shows ten rows a page, and a cell wraps to a
second line (a phone shows a third of a narrow card a column). A card holds five tables,
so with more machines than that the smallest share one, its heading naming them all
(`box · nas`). Telegram has no tables: the same as lists, each line its
mark, its topic (a link), its state and its latest.

- The overview before it is never taken back (in Feishu a recall leaves a "recalled a
  message" line): it is edited into the record of what it rang for. A record is history,
  read for its details, so it is not a table: each note in full, a few lines (what, the
  room, when; its first line; once handled, how and when). So above the newest overview
  the chat keeps a history of what rang.
- **needs you** rings at once: a dialog, or a message it did not start working on.
- **done** waits `HERDR_DONE_WAIT` seconds (60 by default). If you send a message in that
  room meanwhile, or the terminal works again, you were watching, and nothing rings. It
  asks nothing of you, so it rings once and is not kept waiting for you: the room shows
  done in its session's table, with what it said.
- **While you are in a room** (you wrote or tapped a card there in the last
  `HERDR_DONE_WAIT` seconds), a "needs you" from it waits the same way, and rings nothing
  if you answer meanwhile: answering one question after another does not ring each time.
- A "needs you" is handled when the dialog is answered (from the card, the group or the
  terminal), you send a message in its room, the terminal works again, or it ends. Its
  room leaves "waiting for you" (an edit, no ring). A room has one note at most: a newer
  one takes its place. Several notes within two seconds ring once.
- Notes and records are kept in `state.json`, so one due while the bot restarted still
  rings, and one whose terminal moved on meanwhile is marked handled.
- In Feishu, until `/auth` is done the groups are not muted and ring on every post too;
  the overview says so at its bottom.

## Answering a dialog from the chat

### From the agent itself, when it can say

When the agent can tell herdrchat what it asks, that comes first, and no screen is read:
OpenCode through its own API (`opencode api`: its forms and permission requests), Claude
Code and Codex through herdrchat's hook in their settings (`herdrchat hooks install`,
`lib/hooks/ask.sh`, their PermissionRequest hook). The hook leaves the request in
`~/.local/state/herdrchat/asks/` on the machine the agent runs on and labels its terminal
`herdrchat.ask=<id>` while it waits; that label (an hc event, from a connected machine
too) brings the card, with the agent's own words and options. Codex run through its
shared background service (without `--no-daemon`) runs its hooks there, outside the
terminal: the request then names no terminal, and herdrchat finds it by Codex's session
(the one the terminal's log is of) and labels the terminal itself, every 2 seconds on
this machine and every minute on a connected one. Your tap is written back as
the hook's decision: Claude Code's permissions (Yes, Yes and don't ask again when it offers
rules, No), its questions (one card per question, boxes for a multi-select, your own words;
the answers go back together) and its plan (start, start and accept its edits, keep
planning); Codex's commands, patches and MCP tools (Yes, No, Answer in the terminal). Esc
on a card stops Claude, as in its own prompt; for Codex it says no.
The terminal still works: Claude shows its prompt as usual, and an answer there closes
the card. Codex shows its prompt only once the hook is done: "Answer in the terminal"
hands it back, and so does the time running out (10 minutes; 30 for Claude). Once the
hook is done the card closes, and a dialog still on the screen gets a card of its own.
Codex's questions come from its own log (no hook is needed for them). In Plan mode it
asks with `request_user_input` and waits: the card has its words (the header, the
question, each option's note, "question 1 of 2"), one card per question, plus "None of the
above" with your own words; a tap presses that option's number in its prompt (your own
words: down to "None of the above", tab, the words, Enter), once the screen shows that
very question. Its other way, `request_user_input_async`, does not wait: the turn ends,
and your answer is just your next message. Its card stays while Codex is idle; your taps
(one per question) go as one message ("Which fruit? Pear", one line each), and anything
you type in the group answers it too. Once Codex works again the card closes.
A dialog the agent does not name this way (and every dialog without the hook) is read off
the screen, below.

### From the screen

A button presses that option's number key in the terminal (Esc presses esc). A question
with previews (a box beside its options) takes no number, so there the button moves with
the arrows from the cursor to that option and presses Enter. In a multi-select, a box is
ticked on the card only, at once; Next sends them all: each box that differs from the
screen is pressed, then tab.
Before it presses anything, the bot reads the screen again and checks that it still
shows the same dialog (a hash of it, from its top border to its last option, without the
cursor, the check marks and the preview box) and the same option, so an old card can never answer a newer dialog that looks alike. After the
key, the card turns into the dialog's next step (a toggled box, the next question, the
review) or says what was picked. Text you type in the group while it waits goes into its
"Type something" box when it has one.

A dialog answered in the terminal (or left for the next one) closes its card: the
buttons go and the card says so. The screen is read the moment `blocked` arrives, so a
dialog answered in the terminal at once still gets its card; and since hc sends a turn
event only when a program leaves `working`, status events catch a program that goes
from one dialog straight to the next. One dialog gets one card.

### Before an agent starts

What an agent shows before it starts waits on you too: Claude Code asks to trust a folder
it never ran in; Codex offers its update, then asks to trust the folder. hc has no status
for an agent until it is up, and nothing of the agent's own runs before that (no hook, no
session), so this is read off the screen: only while the agent's process runs with no
status, and only a menu, numbered or not. Its card ("⚠️ Needs you (to start)") comes a few
seconds after the terminal starts, or at the next minute's look; a tap moves with the
arrows to the option and presses Enter, and the card turns into what it asks next. What
you type meanwhile waits and goes in once it has started: typed in, its Enter would pick
the option under the cursor (Claude's is "No, exit"). The card closes as the agent comes
up, and says so when the terminal ended instead.

## Secrets are hidden

What is posted is kept on the chat app's servers, and a Feishu tenant's admins may read
it; a bot's chat in Telegram is not end-to-end encrypted. So before anything goes out (a
post, a card, a dialog, the conversation's file, the overview, its records), and before
anything is logged, what looks like a secret is hidden: `[hidden: GitHub token]`. The log
says only what kind was hidden, never what it was.

| Hidden | For example |
|---|---|
| a key with a shape of its own | `sk-…` (OpenAI, Anthropic), `ghp_…`, `github_pat_…`, `glpat-…`, `xoxb-…`, `AKIA…`, `AIza…`, `sk_live_…`, `npm_…`, a Telegram bot token, a JWT |
| a private key | the whole `-----BEGIN … PRIVATE KEY-----` block |
| a value given to a name that says secret | `API_KEY=…`, `"client_secret": "…"`, `password: …` (the name stays; a number alone is a count, not a secret) |
| a header's or a URL's | `Authorization: Bearer …`, `postgres://user:…@host` |
| the bot's own | the secrets and tokens in its `config.env`, wherever they show |
| your words | `HERDR_REDACT_WORDS` |

It is a safety net, not a guarantee: only what has such a shape is hidden (never a guess
at random-looking text, which commit ids and UUIDs look like too), so a password said in
plain words still goes, and so does one in an image. What was posted before is left as it
was, the agent itself sees everything, and what you type in a room goes to it as it is.
`HERDR_REDACT=off` hides nothing.

## Nothing is lost

- What was posted is remembered per terminal in `state.json` (entry ids, not only a
  time), so a restart picks up where it stopped, entries with the same timestamp or
  written late are still posted, and nothing is posted twice.
- A post that fails is retried (2, 4, 8, 16 s); if it still fails the cursor stays, and the
  content goes out with the next post. A repeat is acceptable, a loss is not.
- The "⌛️ Working…" card holds everything, not a status line. A full card (20 KB in Feishu,
  one message in Telegram, as the app measures it) is closed and the next one goes on; a
  card the app will not edit is sent again as a new one. Which
  card is open is kept in `state.json`, so a restart goes on editing it. While it
  works, the turn's last answer is left for the turn's end, so it always arrives as its
  own message.
- What does not get through (the network, a timeout, the service's own error) is never
  taken for a refusal: a live card is edited again with what came meanwhile, not sent a
  second time; closing it is tried again; the overview is shown again 30 seconds later;
  a pin whose unpin did not get through is taken off at the next minute's look
  (Telegram's dialog card; a group an older version pinned on Feishu).
- After a turn ends the bot waits for the agent's last answer (for Claude,
  `stop_reason: end_turn`); hc reports the end before the agent writes it.
- Idle terminals with a reader are checked again at start, after every event snapshot and
  every minute, so a missed event or a late write is caught up.
- When a Claude session moves to a new transcript (`/clear`, resume), what is left in the
  old one is posted first; when a terminal ends, what its log still holds is posted first.
- Some of what Claude says while it works is stored only as a "narration" block (a thinking
  block whose signature names narration); it is posted too. It holds a condensed version of
  the text shown on screen, the only version on disk.

On the first start the bot posts only what happens from then on, never older history.
A new room is not empty: it gets the conversation before it, all of it as a `.md` file
and its newest part in one folded post, silent and never repeated (`HERDR_HISTORY` says
which: `file,folded` by default, `file`, `folded`, or empty for neither). `/history` in a
room posts both again.

A room is an agent's: a terminal gets one once an agent runs in it (or is starting), never
a shell or another program alone (`node`, a tunnel): it has nothing to say, and its title,
the command it runs, would name the group (a token on a command line in a group's name).
Type `claude` in a shell tab and its room comes once hc sees the agent. When the agent
quits, its room stays and keeps its name while the shell runs; what you type there gets
one reply, the screen a moment later, without blank lines. A group made by an older
version for a terminal no agent ran in is ended (tagged `herdr-ended`), never deleted.

A group belongs to its tab (by the tab's id, `herdr.tab`, when it has one): when the tab's terminal is
replaced, the new terminal carries on in the same group. A message that cannot be
delivered (the terminal has ended) says so plainly.

## Updating

When npm has a newer herdrchat than the one running, the bot says so once per version in
the direct chat, with an **Update to x.y.z** button (it asks npm once a day, through npm,
so a registry you set is used; only a copy installed with `npm install -g` is offered
one). `herdrchat update [version]` in a terminal does the same; with an older version it
goes back to it. Both:

1. install it with `npm install -g herdrchat@<version>`;
2. replace the copy of the hook the agents run, when it is in and differs (their
   settings are left alone);
3. update the skill with `npx skills update herdrchat -g`, when it is installed.

Nothing is restarted by the update itself: every bot looks at its code on disk each
minute, and once it is another version, a bot that its service or `herdrchat start`'s
loop starts again stops and comes back on it; it then says "herdrchat is now x.y.z (was
…)". So all profiles move together, however herdrchat was updated. A bot run by hand
(`herdrchat run`) is never stopped: it says once that it needs a restart. A git checkout
is never updated from here: pull it, and the running bots follow the version in its
`package.json`.

## Commands

- Direct chat: `/ls` (the overview again at the bottom of the chat; the old one says it
  is old: nothing is recalled, which in Feishu leaves a "recalled a message" line), `/new` (start one,
  from a form, below; or with words, on this computer: `/new <session> <space>/<tab>
  [command]`, default `claude`, `--cwd <dir>` first to pick its folder), `/kill <session> <address>` (or `/kill` in the
  terminal's own room), `/usage` (every
  account's limits, above), `/auth` (Feishu; see below). Telegram lists them when you
  type `/`; Feishu can have a bot menu for `/ls`, `/usage`, help and `/auth` (set in the
  developer console: `skills/herdrchat/references/feishu.md`, "The bot menu").
- The new-terminal form (`/new` alone, the overview's **＋ New terminal** button, or
  Feishu's bot menu item `new`): the **space** (one there is, each machine's by name, or
  a new space on this computer or on a machine reached over a link, which then needs a
  name), the **agent** (Claude Code, Codex, OpenCode or Pi; no shell: it would get no room), the **tab** (empty:
  the agent's name, numbered past the tabs the space has) and the **folder**, picked: the
  space's own (the default; a new space's: home), one your terminals already work in
  (each with its machine; one on another machine than the space is refused), or another
  folder, whose path you then type. Only what applies shows: a folder on the space's machine, a
  new space's name once you pick a new space, a path once you pick another folder. In
  Feishu a card: each pick a drop-down that redraws the card the moment it changes, then
  the text boxes and Start (pick first, then type: a box is not kept when a pick changes);
  in Telegram a field at a time: buttons for a pick, your next message in its topic for a
  text, with Skip. An agent starts through the project's own launcher when the folder has
  one: `<agent>.sh` there, `scripts/<agent>.sh` or `script/<agent>.sh` (`claude.sh`,
  `codex.sh`, `pi.sh`, `opencode.sh`), the first that may be run, looked for on the
  folder's machine; else its own command (`claude`). What the project sets up first
  (secrets through `op run`, git hooks, flags) comes with it, and the card says which ran. hc
  starts it (`hc run`, `--on` for another machine, through that machine's own login
  shell) with the labels that say where it is (herdr-app reads them too, and numbers the
  tab in its sidebar), so it needs nothing but hc. The card then says it started, or why not.
  A form is used once; one from before a restart says it is old.
- In a terminal's room: any text goes to it (marked once typed in, and again when the
  turn that took it is over); an image (alone or in a rich text message) is sent
  beside the terminal with `hc put`, on its machine, and its path is typed in with your
  text, so an agent like Claude Code opens it; `/screen`, `/answer <text>` (type into the
  dialog it waits on, as is), `/esc`, `/history` (the conversation so far, as a file and
  a folded post), `/kill` (end this terminal). Dialog cards have buttons.
- On the command line, `herdrchat hooks` says whether herdrchat's hook is in Claude Code's
  and Codex's settings and its extension in Pi's; `herdrchat hooks install
  [claude|codex|pi]` puts them in (it shows the files and asks first; `--yes` does not
  ask), `herdrchat hooks uninstall` takes them out. See "From the agent itself, when it can
  say". Pi's is not a hook: `~/.pi/agent/extensions/herdrchat.js` labels the terminal with
  the session file each pi writes (`herdrchat.pi-session`), which Pi names to nobody else,
  so two pi in one folder each keep to their own room; without it each room follows the
  folder's newest session.

`herdrchat setup` does the steps below by asking: it checks the token or the Feishu keys
at once, picks the sessions, starts the bot and pairs you as its owner with a 6-digit
code you send to the bot, then offers the service. The steps say what happens, and how
to do it by hand. When the owner is missing later, `herdrchat pair` shows a new code.

## Set up: Telegram

1. In Telegram, message **@BotFather**: `/newbot`, give it a name and a username ending
   in `bot`. It answers with a token; keep it private.
2. Turn on topics for the bot: in the BotFather chat tap **Open** (its mini app), pick the
   bot, turn on **Threaded Mode**. Without it the bot cannot make topics.
3. `herdrchat init --chat telegram` (with `--profile <name>` too if you also run Feishu)
   prints where its `config.env` is. Fill in `TELEGRAM_BOT_TOKEN`. `HERDR_SESSIONS`
   can stay empty for hc's default session (`ls ~/.local/state/herdr-core` lists yours).
4. `herdrchat start`, then `herdrchat pair`: it shows a 6-digit code. Open the bot (tap
   Start) and send it the code; the bot makes you its owner and starts again. One topic per
   tab appears in your private chat with the bot (Telegram takes about one message a
   second, so many tabs take a moment).
5. Once it works: `herdrchat install` (see "Running as a service").

If Telegram is your only app, use the default profile with `--chat telegram`. Use
`--profile <name>` only for a second chat app beside the first.

## Set up: Feishu

Feishu only: Lark (the international version) is not supported yet. Steps 1, 2, 5 and 6
are in the Feishu developer console (`https://open.feishu.cn/app`). The herdrchat skill
(`/herdrchat setup`) clicks them for you with the [Ego Lite](https://lite.ego.app/)
browser, or tells you what to click without it; or follow the steps here yourself.

1. Create a custom app (企业自建应用) and add the bot ability (机器人).
2. Permissions: import the scopes listed in `skills/herdrchat/references/feishu.md`,
   "Scopes this bot uses" (there as JSON for the batch import): sending as the bot,
   reading the messages sent to it, making and renaming groups, reactions, images both
   ways, and group tags.
3. `herdrchat init` prints where its `config.env` is. Fill in the app's App ID and App
   Secret (the app's 凭证与基础信息 page). `HERDR_SESSIONS` can stay empty for hc's
   default session (`ls ~/.local/state/herdr-core` lists yours).
4. `herdrchat start`. The bot must be running for the next step: the console checks for
   a live connection.
5. Events and callbacks (事件与回调): for events, choose the long connection mode (长连接)
   and add `im.message.receive_v1` and `application.bot.menu_v6` (the bot menu's
   clicks); for callbacks (回调配置), choose the long connection mode too and add
   `card.action.trigger` (the dialog buttons).
6. The bot menu (机器人 -> 机器人自定义菜单): four buttons in the direct chat, Overview,
   Usage, Help and Act as me, so you tap instead of typing `/ls`, `/usage`, help or
   `/auth`. Feishu has no `/` list, so this is how you find the commands; it can only
   be set here. The steps: `skills/herdrchat/references/feishu.md`, "The bot menu".
7. Publish a version (one for all of the above). If the page does not say 本次发布免审核,
   your team's admin must approve it first.
8. `herdrchat pair`: it shows a 6-digit code. In Feishu, search the app's name, open the
   bot and send it the code; the bot makes you its owner and starts again. One group per
   tab appears. When the code gets no answer, step 5 or 7 is not done.
9. Optional: send `/auth` (or tap Act as me) so the bot can mute its groups for you
   ("Optional: let the bot act as you").
10. Once it works: `herdrchat install` (see "Running as a service").

## Running as a service

`herdrchat start` runs the bot in an hc terminal, which ends when that hc core stops,
and nothing starts it after a reboot. `herdrchat install` makes it a service of the
system instead: a launchd agent on macOS, a systemd user unit on Linux. It starts at
login, comes back by itself after a crash, and does not depend on any hc core. It runs
node and the bot by their full paths with only the variables it needs (hc's path, PATH,
the profile, the folders), so no agent's variables come along. With it installed,
`start`, `stop` and `status` go through the service; `herdrchat uninstall` removes it.
Each profile is its own service (`herdrchat install --profile telegram`).

- After a node upgrade that moves node, run `herdrchat install` again; `herdrchat status`
  says when the service's node is gone.
- On Linux, `loginctl enable-linger` keeps it running after you log out.
- What the process prints before its log is open (a crash at start) goes to
  `logs/service.out.log` in the state folder.

## Optional: let the bot act as you

Some chat-list settings only you can change. Send `/auth` in the direct chat and allow it
on Feishu's page (OAuth device flow: a link and a code, no public address needed); the
token is refreshed on its own and kept in `user-token.json` in the state folder (mode 600).
Then:

- groups are muted (`HERDR_MUTED_SPACES` in `config.env`: `all`, the default; empty for none; or
  some spaces, comma-separated; a change applies both ways at the next start), so only the
  overview in the direct chat rings ("What rings: the overview, sent anew" above;
  `HERDR_SILENT_SPACES` rings nothing);
- each group is also in your own label `herdr`, and once its terminal is gone in
  `herdr-ended` too (the bot's tags have the same two names, one at a time: `herdr`
  while live, `herdr-ended` once ended), to filter the chat list by.
  To keep the bot's groups out of the message list, so it holds only the direct chat
  (which rings for what needs you) and your other chats: right click `herdr` >
  消息展示设置 > 始终不展示 (or 有新消息时展示), once; new groups go into it by themselves
  (Feishu 5.29 or later; a bot cannot set this). Your labels need `/auth`: without it a
  group cannot leave the message list. The bot's tags show next to a group's name, with
  `/auth` or without. Either can be turned off: `HERDR_USER_TAGS=off` takes the
  groups out of your labels (the labels stay), `HERDR_BOT_TAGS=off` takes the bot's tags
  off (they are tenant tags, visible to the whole tenant).

No group is pinned: a pin is yours, and Feishu does not tell the bot's from yours, so
the bot would take yours off with its own. Pin what you like; the bot leaves it. Pins
an older version made are taken off once.

The app needs these user scopes: `im:chat.user_setting:write`, `im:feed_group_v1:read`,
`im:feed_group_v1:write`, `offline_access`. Without `/auth`
none of this happens and everything else works the same. If the token can no longer be
refreshed, the bot says so once and falls back.

## Skills

`skills/herdrchat/` is one skill for an agent (Claude Code or another that reads
`SKILL.md`): `/herdrchat setup`, `status`, `start`, `stop`, `install`, `logs`, `auth`,
`config`, `fix`, `feishu <task>` (the developer console, with Ego Lite from
https://lite.ego.app/ or as a guided walk-through) and `telegram <task>` (the bot, from
@BotFather to the first topic). Details per part are in `skills/herdrchat/references/`.
Install it with `npx skills add zhangxiangliang/herdrchat` (README); from a clone you can
link it instead, for example `ln -s "$PWD/skills/herdrchat" ~/.claude/skills/herdrchat`.

## Logs

Everything the bot logs goes to `logs/<YYYY-MM-DD>.log` in the state folder, one file a
day by your local date (the last 14 kept), as `<time> <LEVEL> <text>` with the time in
UTC. `herdrchat logs` shows today's (`--errors` only what went wrong, `--day 2026-01-31`
another day); a retry that recovered is a `WARN`, and a crash leaves its stack there
before it is started again. Tokens and secrets are never logged. The skill's
`references/ops.md` explains the lines.

## Limits

- Narration blocks are a condensed version of the text Claude showed, not the exact words.
- Claude Code, Codex, OpenCode and Pi have readers. Any other program posts nothing by
  itself; what you type to it gets its screen in reply.
- Codex: its log is found as the one written in its folder since it started (Codex names
  no pid outside its database), so two Codex sessions started in the same folder at the
  same moment could be told apart wrongly. It has no multi-select. A group is named after
  Codex's thread name once it has one.
- Only text, images and rich text are passed on; files, stickers and the rest are not.
- An image that fails to upload three times is not sent; the group says so and why.
- Feishu only, not Lark (the international version) yet: the bot talks to open.feishu.cn.
- Avatars are drawn with `sips`, so only on macOS; elsewhere groups keep Feishu's default.
- Telegram: a bot cannot mute a topic for you; a topic you mute in Telegram stays fully
  quiet, "needs you" included. Closing a topic is documented for supergroups only, so an
  ended topic is marked by its name.
- Without the agent naming its dialog (its API, or the hook), dialog buttons come from
  the screen's numbered menu; a dialog drawn some other way gets the screen and
  `/answer`, `/esc`.
- The hook (`herdrchat hooks install`) goes in on this machine only; on a connected
  machine, install herdrchat there and run it there too.
