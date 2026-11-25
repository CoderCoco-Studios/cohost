#!/usr/bin/env bash
# Compose smoke check: build the TS service images and verify they come up healthy (regression guard for #6,
# where `pnpm prune --prod` dropped @cohost/* links and every container crash-looped).
# Only services that need no models/credentials: redis + salience affect avatar (the dashboard runs on the host, not in Compose), then tools to check its redis-only network (DEPLOY-NET-004).
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
# wait_healthy <service>: ok when the service reaches `healthy` with no restart within the shared budget; returns 1 otherwise.
# @spec DEPLOY-IMG-002, DEPLOY-IMG-003
wait_healthy() {
  local s=$1 id state
  id=$(docker compose ps -aq "$s")   # -a: a service that already exited must still be found and reported
  if [ -z "$id" ]; then echo "FAIL $s (no container)"; docker compose logs --tail 20 "$s" || true; return 1; fi
  while :; do
    state=$(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}} restarts={{.RestartCount}}' "$id")
    if [ "$state" = "running healthy restarts=0" ]; then echo "ok   $s"; return 0; fi
    # Only "still starting, never restarted" can recover; a restart, an exit or an unhealthy verdict cannot.
    if [ "$state" = "running starting restarts=0" ] && (( SECONDS < deadline )); then sleep 1; continue; fi
    echo "FAIL $s ($state)"; docker compose logs --tail 20 "$s"; return 1
  done
}
for s in "${SERVICES[@]}"; do wait_healthy "$s" || fail=1; done

# The tools network (DEPLOY-NET-004): once the named services are healthy, start tools and check, from inside it, that the bus
# name resolves and that another service's name does not: tools shares a network with redis alone.
if [ $fail -eq 0 ]; then
  docker compose up -d --build tools
  if wait_healthy tools; then
    lookup='const dns = require("node:dns"); dns.lookup(process.argv[1], (err) => process.exit(err ? 1 : 0));'
    if docker compose exec -T tools node -e "$lookup" redis; then echo "ok   tools resolves redis"; else echo "FAIL tools cannot resolve redis"; fail=1; fi
    if docker compose exec -T tools node -e "$lookup" salience; then echo "FAIL tools resolves salience (it shares a network with it)"; fail=1; else echo "ok   tools does not resolve salience"; fi
  else
    fail=1
  fi
fi
exit $fail
