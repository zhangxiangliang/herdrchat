#!/bin/sh
# Walks the user's way in, as the README tells it, in a clean throwaway home: install the
# command, install the skill, init, status, start without settings. Every step must give
# what a user is told to expect, or this fails (and CI stops the release).
#
#   scripts/smoke.sh local       the package packed from this checkout, the skill from it
#   scripts/smoke.sh published   herdrchat@latest from npm, the skill from GitHub
#   SMOKE_SKILL=0                skip the skill step (it needs npx skills)
set -eu

MODE="${1:-local}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'case "$WORK" in /tmp/*|/var/folders/*|/private/*|"${RUNNER_TEMP:-/nonexistent}"/*) rm -rf "$WORK";; esac' EXIT
export HOME="$WORK/home" npm_config_prefix="$WORK/npm" HERDRCHAT_HOME="$WORK/herdrchat"
mkdir -p "$HOME"
export PATH="$WORK/npm/bin:$PATH"

step() { printf '\n== %s\n' "$*"; }
fail() { printf 'SMOKE FAILED: %s\n' "$*" >&2; exit 1; }
expect() { # expect <what> <pattern> <output>
  printf '%s\n' "$3" | grep -qE "$2" || { printf '%s\n' "$3" >&2; fail "$1: expected /$2/"; }
}

step "install the command ($MODE)"
if [ "$MODE" = published ]; then
  npm install -g herdrchat@latest >/dev/null
  SKILL_SOURCE=zhangxiangliang/herdrchat
else
  (cd "$ROOT" && npm pack --silent --pack-destination "$WORK" >/dev/null)
  npm install -g "$WORK"/herdrchat-*.tgz >/dev/null
  SKILL_SOURCE="$ROOT"
fi
command -v herdrchat >/dev/null || fail "herdrchat is not on PATH after npm install -g"

step "herdrchat --version"
out="$(herdrchat --version)"
expect "version" '^[0-9]+\.[0-9]+\.[0-9]+$' "$out"
[ "$MODE" = published ] || [ "$out" = "$(node -p "require('$ROOT/package.json').version")" ] || fail "version $out is not package.json's"

step "herdrchat with no command lists the commands"
expect "usage" 'init.*start.*stop' "$(herdrchat | tr '\n' ' ')"

step "an unknown command says so"
if out="$(herdrchat nosuchcommand 2>&1)"; then fail "an unknown command exited 0"; fi
expect "unknown command" 'Unknown command: nosuchcommand' "$out"

step "start with no settings says to run init"
if out="$(herdrchat start 2>&1)"; then fail "start with no settings exited 0"; fi
expect "no settings" 'herdrchat init' "$out"

step "herdrchat init --chat telegram"
out="$(herdrchat init --chat telegram)"
expect "init" 'Made .*config.env' "$out"
grep -q '^HERDRCHAT_CHAT=telegram$' "$HERDRCHAT_HOME/config.env" || fail "init did not set HERDRCHAT_CHAT=telegram"

step "status names what is missing"
out="$(herdrchat status)"
expect "status sessions" 'sessions +none yet' "$out"
expect "status token" 'token +missing' "$out"

step "start names the empty setting"
if out="$(herdrchat start 2>&1)"; then fail "start with empty settings exited 0"; fi
expect "empty sessions" 'HERDR_SESSIONS is empty' "$out"

if [ "${SMOKE_SKILL:-1}" = 0 ]; then printf '\nSMOKE OK (%s, skill not tried)\n' "$MODE"; exit 0; fi
step "the skill installs ($SKILL_SOURCE)"
out="$(npx -y skills add "$SKILL_SOURCE" --list 2>&1)" || { printf '%s\n' "$out" >&2; fail "skills add --list failed"; }
expect "skill listed" 'herdrchat' "$out"
printf '%s\n' "$out" | grep -qiE 'skipped|no valid skills' && { printf '%s\n' "$out" >&2; fail "the skills tool skipped the skill"; }
npx -y skills add "$SKILL_SOURCE" -g -a claude-code -y >/dev/null 2>&1 || fail "skills add -g -a claude-code -y failed"
[ -f "$HOME/.claude/skills/herdrchat/SKILL.md" ] || fail "the skill is not in ~/.claude/skills/herdrchat after skills add"

printf '\nSMOKE OK (%s)\n' "$MODE"
