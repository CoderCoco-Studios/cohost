#!/usr/bin/env bash
# Compose smoke check: build the TS service images and verify they stay up (regression guard for #6,
# where `pnpm prune --prod` dropped @cohost/* links and every container crash-looped).
# Only services that need no models/credentials: redis + salience affect avatar dashboard.
# Usage: scripts/compose-smoke.sh [service...]
set -euo pipefail
cd "$(dirname "$0")/.."
SERVICES=("$@"); [ ${#SERVICES[@]} -gt 0 ] || SERVICES=(salience affect avatar dashboard)
[ -f .env ] || cp .env.example .env
cleanup() { docker compose down -v >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker compose up -d --build redis "${SERVICES[@]}"
sleep "${SMOKE_WAIT:-15}"   # a crash-looping container restarts well within this window

fail=0
for s in "${SERVICES[@]}"; do
  id=$(docker compose ps -q "$s")
  state=$(docker inspect -f '{{.State.Status}} restarts={{.RestartCount}}' "$id")
  if [ "$state" = "running restarts=0" ]; then echo "ok   $s"; else
    echo "FAIL $s ($state)"; docker compose logs --tail 20 "$s"; fail=1
  fi
done
exit $fail
