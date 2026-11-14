#!/bin/sh
# Waits for what a push to main sets off, and says how it ended: CI and Release on the
# pushed commit, then (when Release published a version) npm serving it and the
# Published check on it. Each run is found by its commit, never by when it started:
# CI and Release run on the pushed commit; Published runs on the commit Release made
# (`chore(release): x.y.z`), the one the new tag points to.
#
#   scripts/wait-release.sh          the commit HEAD is (pushed already)
#   scripts/wait-release.sh <sha>    that commit
#   WAIT_MINUTES=15                  give up after this long (the whole thing takes ~2;
#                                    npm once took 8 to serve a new version)
#
# Exits 0 when all went well, 1 when a run failed, 2 when it gave up waiting.
set -eu

SHA="$(git rev-parse "${1:-HEAD}")"
SHORT="$(printf '%s' "$SHA" | cut -c1-7)"
LIMIT=$(( ${WAIT_MINUTES:-15} * 60 ))
START="$(date +%s)"
STEP=10

elapsed() { echo $(( $(date +%s) - START )); }
say() { printf '[%3ss] %s\n' "$(elapsed)" "$*" >&2; } # on stderr: also from inside $(…)
give_up() { say "gave up after ${WAIT_MINUTES:-15} min: $*"; say "look at: gh run list --limit 5"; exit 2; }
tick() { [ "$(elapsed)" -lt "$LIMIT" ] || give_up "$1"; sleep "$STEP"; }

# run_of <workflow file> <head sha>: the id of that workflow's run on that commit, once it exists
run_of() {
  while :; do
    id="$(gh run list --workflow "$1" --commit "$2" --limit 1 --json databaseId -q '.[0].databaseId // empty')"
    [ -n "$id" ] && { echo "$id"; return; }
    tick "no $1 run on $(printf '%s' "$2" | cut -c1-7) yet"
  done
}

# watch <id> <name>: waits until the run is over; fails the script if it did not succeed
watch() {
  last=''
  while :; do
    state="$(gh run view "$1" --json status,conclusion -q '"\(.status) \(.conclusion)"')"
    [ "$state" = "$last" ] || say "$2: $state"
    last="$state"
    case "$state" in
      'completed success') return ;;
      completed*) say "$2 failed: gh run view $1 --log-failed"; exit 1 ;;
    esac
    tick "$2 is still ${state% *}"
  done
}

say "commit $SHORT: $(git log -1 --format=%s "$SHA")"
release="$(run_of release.yml "$SHA")"
ci="$(run_of ci.yml "$SHA")"
watch "$ci" CI
watch "$release" Release

# A version came out of this push when the newest tag points to a commit made on top of it.
tag="$(gh release view --json tagName -q .tagName)"
made="$(gh api "repos/{owner}/{repo}/commits/$tag" -q .sha)"
if [ "$(gh api "repos/{owner}/{repo}/commits/$made" -q '.parents[0].sha')" != "$SHA" ]; then
  say "no version from this commit (newest is still $tag): a feat or fix publishes one"
  exit 0
fi
version="${tag#v}"
say "Release made $tag"

until [ "$(npm view herdrchat version 2>/dev/null)" = "$version" ] \
  && curl -sfI "$(npm view "herdrchat@$version" dist.tarball)" >/dev/null 2>&1; do
  tick "npm does not serve $version yet"
done
say "npm serves herdrchat $version"

watch "$(run_of published.yml "$made")" Published
say "done: herdrchat $version is out, and installs and runs from npm"
