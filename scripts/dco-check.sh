#!/usr/bin/env bash
# DCO check: every non-merge commit in <base>..<head> must carry a `Signed-off-by: Name <email>` line
# that matches the commit's author. Commits outside the range (already on the base branch) are not checked.
# Usage: scripts/dco-check.sh <base-sha> <head-sha>
# @spec DEPLOY-CI-005
set -euo pipefail
base=${1:?usage: dco-check.sh <base-sha> <head-sha>}
head=${2:?usage: dco-check.sh <base-sha> <head-sha>}

fail=0
count=0
while read -r sha; do
  count=$((count + 1))
  name=$(git log -1 --format=%an "$sha")
  email=$(git log -1 --format=%ae "$sha")
  if git log -1 --format=%B "$sha" | tr -d '\r' | grep -Fxq "Signed-off-by: $name <$email>"; then
    echo "ok   ${sha:0:12} signed off by $name <$email>"
  else
    echo "FAIL ${sha:0:12} $(git log -1 --format=%s "$sha")"
    echo "     missing 'Signed-off-by: $name <$email>' (commit author); fix with: git rebase --signoff <base>" >&2
    fail=1
  fi
done < <(git rev-list --no-merges "$base..$head")

echo "checked $count commit(s)"
exit $fail
