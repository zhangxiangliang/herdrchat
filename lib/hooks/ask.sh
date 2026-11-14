#!/bin/sh
# herdrchat's PermissionRequest hook for Claude Code and Codex (`herdrchat hooks install`
# puts it in their settings): what the agent asks you (a permission, Claude's questions,
# its plan) goes to your chat as a card with the agent's own words and options, and your
# answer there comes back as the hook's decision. Nothing is decided here by itself.
#   sh ask.sh <claude|codex> <seconds to wait> [<seconds for Claude's prompt to show>]
#
# In an hc terminal ($HC_TERMINAL_ID): the request is left in
# ~/.local/state/herdrchat/asks/req/<id>.json, with the agent and the terminal around it,
# and the terminal gets the label herdrchat.ask=<id>, which tells herdrchat (hc's events
# carry it, from a connected machine too). herdrchat writes the decision to
# ans/<id>.json, printed here as it is; an empty answer is no decision. The label goes
# when this ends. Codex run through its shared background service (without --no-daemon)
# runs this there, outside the terminal: then the request is left with no terminal, and
# herdrchat finds the terminal by Codex's session and labels it itself.
#
# The terminal stays a way to answer. Claude shows its own prompt while this waits: once
# Claude's status has been blocked and is not any more, it was answered there, and this
# goes with no decision; and when it never shows blocked (answered at once, or no
# prompt to see) this goes after a few seconds, so nothing waits on a card for nothing.
# Codex shows its prompt only once this is done: the card's "Answer in the terminal" (an
# empty answer) or the time running out hands it back. No answer in time, the terminal
# ending, or any error: no decision.

agent="${1:-claude}"
wait_s="${2:-1790}"
t="${HC_TERMINAL_ID:-}"
case "$agent" in claude|codex) ;; *) exit 0 ;; esac
[ -n "$t" ] || [ "$agent" = codex ] || exit 0
case "$t" in *[!A-Za-z0-9._/-]*|*..*) exit 0 ;; esac
case "$wait_s" in ''|*[!0-9]*) wait_s=1790 ;; esac
grace="${3:-10}"
case "$grace" in ''|*[!0-9]*) grace=10 ;; esac
[ -z "$t" ] || command -v hc >/dev/null 2>&1 || exit 0

d="$HOME/.local/state/herdrchat/asks"
umask 077
mkdir -p "$d/req" "$d/ans" 2>/dev/null || exit 0
find "$d/req" "$d/ans" -type f -mmin +1440 -exec rm -f {} + 2>/dev/null

# <seconds>-<this pid>: herdrchat tells a live request from one left behind by the pid
id="$(date +%s)-$$"
req="$d/req/$id.json"
ans="$d/ans/$id.json"

# hc get, on one line; empty when hc can't tell (or there is no terminal)
terminal() { [ -n "$t" ] && hc get "$t" --json 2>/dev/null | tr -d '\n'; }
done_() {
  rm -f "$req" "$req.tmp" "$ans" "$ans.tmp"
  # the label only while it is still this request's (a newer one may have taken it)
  case "$(terminal)" in *"\"herdrchat.ask\":\"$id\""*) hc label "$t" "herdrchat.ask=" >/dev/null 2>&1 ;; esac
  exit 0
}
trap done_ TERM INT HUP

{
  printf '{"agent":"%s","terminal":"%s","at":%s,"request":' "$agent" "$t" "$(date +%s)"
  cat
  printf '}\n'
} > "$req.tmp" 2>/dev/null && mv "$req.tmp" "$req" 2>/dev/null || done_
[ -z "$t" ] || hc label "$t" "herdrchat.ask=$id" >/dev/null 2>&1 || done_

armed=0
started=$(date +%s)
end=$(( started + wait_s ))
while [ "$(date +%s)" -lt "$end" ]; do
  if [ -f "$ans" ]; then
    cat "$ans" 2>/dev/null
    done_
  fi
  now="$(terminal)"
  case "$now" in
    '') ;;
    *'"state":"live"'*)
      case "$now" in
        *'"status":{'*'"state":"blocked"'*) armed=1 ;;
        *) if [ "$agent" = claude ]; then
             [ "$armed" = 1 ] && done_ # answered in the terminal
             [ $(( $(date +%s) - started )) -ge "$grace" ] && done_
           fi ;;
      esac ;;
    *) done_ ;; # the terminal ended
  esac
  sleep 1
done
done_
