# herdr: what herdrchat is built on, and putting it in place

herdrchat mirrors the terminals that **hc** (herdr-core) runs; **herdr-app** is herdr's
desktop and phone app that shows them in spaces and tabs. Without hc on the machine
herdrchat does nothing. Check: `command -v hc && hc --version`.

When hc is missing, help the user install it. Do it from herdr's own instructions, read
now, never from memory or a script kept here: install steps change, and a fixed script
breaks on another system or version.

## Installing it, with the user

1. **Say what and why.** "herdrchat is built on herdr: it mirrors the terminals that hc
   runs. hc is not on this machine. Shall I install herdr for you?" Wait for a yes.
2. **Read the official way, now.** Open https://herdr.dev and follow its install or
   download instructions for this system (macOS or Linux; say so if it is neither). Use
   only what herdr's own site or its official releases give. If the page does not say
   how, stop and tell the user where you looked.
3. **Show before running.** Give the user the exact command or download, where it comes
   from, where it installs, and what it changes (a folder, the PATH, a login item).
   When the instructions pipe a script into a shell, download the script first and read
   it, then say what it does. Run it only after the user says yes to that command.
4. **Check it worked.** `hc --version` answers. If hc is not found, the new folder may
   not be on PATH yet in this shell: say which folder, and how the instructions add it.
5. **A first session.** `hc ls` (or the instructions' own first step) starts the default
   session; `ls ~/.local/state/herdr-core` then lists it. herdrchat's `HERDR_SESSIONS`
   names the sessions to mirror. herdr-app is optional for herdrchat but is how terminals
   get their space and tab names; offer it when the user wants the desktop app too.
6. **On a failure, stop.** Show the error as it is and what was tried. Do not try other
   install ways the user did not agree to, and never run anything with sudo without
   asking for that command.

Then go back to `/herdrchat setup`.
