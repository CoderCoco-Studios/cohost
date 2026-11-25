#!/usr/bin/env bash
# Compose smoke check: build the TS service images and verify they come up healthy (regression guard for #6,
# where `pnpm prune --prod` dropped @cohost/* links and every container crash-looped).
# Only services that need no models/credentials: redis + salience affect avatar (the dashboard runs on the host, not in Compose).
# Each service must reach Compose health status `healthy` with restarts=0 within SMOKE_WAIT seconds (default 60).
# Usage: scripts/compose-smoke.sh [service...]
# @spec DEPLOY-CI-002
set -euo pipefail
cd "$(dirname "$0")/.."
SERVICES=("$@"); [ ${#SERVICES[@]} -gt 0 ] || SERVICES=(salience affect avatar)
[ -f .env ] || cp .env.example .env
cleanup() { docker compose down -v >/dev/null 2>&1 || true; }
trap cleanup EXIT

# The run uses no credential and the workspace is not built (so the projection itself is not available): give every
# ./secrets/units/<name> directory the Compose file mounts an empty projection, mode 0700, and leave an existing file alone.
# The directories are read from docker-compose.yml, because a mount whose source is missing fails `up`.  @spec DEPLOY-SECRET-011
for name in $(grep -o '\./secrets/units/[A-Za-z0-9_-]*' docker-compose.yml | sed 's#.*/##' | sort -u); do
  mkdir -p -m 700 "secrets/units/$name"
  [ -e "secrets/units/$name/secrets.yaml" ] || (umask 077 && echo '{}' > "secrets/units/$name/secrets.yaml")
done

docker compose up -d --build redis "${SERVICES[@]}"
deadline=$((SECONDS + ${SMOKE_WAIT:-60}))   # one budget for all services; a healthy stack passes in about 15 s

fail=0
# @spec DEPLOY-IMG-002, DEPLOY-IMG-003
for s in "${SERVICES[@]}"; do
  id=$(docker compose ps -aq "$s")   # -a: a service that already exited must still be found and reported
  if [ -z "$id" ]; then echo "FAIL $s (no container)"; docker compose logs --tail 20 "$s" || true; fail=1; continue; fi
  while :; do
    state=$(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}} restarts={{.RestartCount}}' "$id")
    if [ "$state" = "running healthy restarts=0" ]; then echo "ok   $s"; break; fi
    # Only "still starting, never restarted" can recover; a restart, an exit or an unhealthy verdict cannot.
    if [ "$state" = "running starting restarts=0" ] && (( SECONDS < deadline )); then sleep 1; continue; fi
    echo "FAIL $s ($state)"; docker compose logs --tail 20 "$s"; fail=1; break
  done
done
exit $fail
