#!/usr/bin/env bash
# cohost installer — Ubuntu/Debian (native) and WSL2.
#   ./scripts/install.sh            # install docker + nvidia toolkit, write .env, pull images
#   ./scripts/install.sh --no-pull  # skip image/model pulls
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT=$(pwd)
PULL=1
for a in "$@"; do [[ "$a" == "--no-pull" ]] && PULL=0; done

log()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31mxx\033[0m %s\n' "$*"; exit 1; }

# ---------------------------------------------------------------- detect env  @spec DEPLOY-INST-001
IS_WSL=0
if grep -qi microsoft /proc/version 2>/dev/null; then IS_WSL=1; fi
. /etc/os-release || die "cannot read /etc/os-release"
case "${ID:-}" in
  ubuntu|debian) ;;
  *) warn "Tested on Ubuntu/Debian; you're on ${ID:-unknown}. Continuing anyway." ;;
esac
log "Platform: $PRETTY_NAME  (WSL2: $IS_WSL)"

HAS_NVIDIA=0
if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi >/dev/null 2>&1; then
  HAS_NVIDIA=1
  log "NVIDIA GPU: $(nvidia-smi --query-gpu=name,memory.total --format=csv,noheader | head -1)"
elif [[ $IS_WSL -eq 1 ]]; then
  warn "nvidia-smi not found in WSL. Install the NVIDIA Windows driver (it exposes CUDA to WSL2) and re-run."
else
  warn "No NVIDIA GPU detected — stack will run CPU-only (slow but functional)."
fi

# ---------------------------------------------------------------- docker  @spec DEPLOY-INST-002, DEPLOY-INST-010
if ! command -v docker >/dev/null 2>&1; then
  if [[ $IS_WSL -eq 1 ]]; then
    warn "Docker not found. On WSL the easiest path is Docker Desktop for Windows with the WSL2 backend"
    warn "enabled for this distro (Settings > Resources > WSL integration). Installing docker-ce in-distro instead..."
  fi
  log "Installing docker-ce"
  sudo apt-get update -qq
  sudo apt-get install -y -qq ca-certificates curl gnupg
  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/$ID/gpg" | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  sudo chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/$ID $VERSION_CODENAME stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update -qq
  sudo apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  sudo usermod -aG docker "$USER" || true
  if [[ $IS_WSL -eq 1 ]]; then sudo service docker start || true; else sudo systemctl enable --now docker; fi
  # This shell does not have the new group yet, so the docker commands below would fail part-way.
  die "Installed Docker and added $USER to the docker group — log out and back in, then re-run ./scripts/install.sh."
fi
docker compose version >/dev/null 2>&1 || die "docker compose plugin missing"

# ---------------------------------------------------------------- nvidia container toolkit  @spec DEPLOY-INST-003
if [[ $HAS_NVIDIA -eq 1 ]] && ! docker info 2>/dev/null | grep -qi nvidia; then
  if [[ -f /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg ]] || command -v nvidia-ctk >/dev/null 2>&1; then
    log "nvidia-container-toolkit present"
  else
    log "Installing nvidia-container-toolkit"
    curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
      | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
    curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
      | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
      | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list >/dev/null
    sudo apt-get update -qq && sudo apt-get install -y -qq nvidia-container-toolkit
  fi
  sudo nvidia-ctk runtime configure --runtime=docker >/dev/null
  if [[ $IS_WSL -eq 1 ]]; then sudo service docker restart || true; else sudo systemctl restart docker; fi
fi

# ---------------------------------------------------------------- node + pnpm (for local dev)  @spec DEPLOY-INST-004, DEPLOY-INST-009
node_major() { node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0; }
if ! command -v node >/dev/null 2>&1 || [[ "$(node_major)" -lt 22 ]]; then
  log "Installing Node 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - >/dev/null
  sudo apt-get install -y -qq nodejs
fi
command -v pnpm >/dev/null 2>&1 || { log "Enabling pnpm via corepack"; sudo corepack enable; corepack prepare pnpm@10.0.0 --activate; }

# ---------------------------------------------------------------- .env  @spec DEPLOY-INST-005, DEPLOY-INST-006
if [[ ! -f .env ]]; then
  cp .env.example .env
  log "Wrote .env from template — fill in Twitch/Discord/OBS values."
fi
for f in config.yaml personality.md expressions.yaml; do
  if [[ ! -f "config/$f" ]]; then
    cp "config/${f%.*}.example.${f##*.}" "config/$f"
    log "Wrote config/$f from its .example — this one is yours (git-ignored)."
  fi
done
if [[ $HAS_NVIDIA -eq 1 ]]; then
  sed -i 's#^COMPOSE_FILE=.*#COMPOSE_FILE=docker-compose.yml:docker-compose.gpu.yml#' .env
  log "GPU overlay enabled in .env (COMPOSE_FILE)"
else
  sed -i 's#^COMPOSE_FILE=.*#COMPOSE_FILE=docker-compose.yml#' .env
fi
mkdir -p data

# begin control-token
# Fill an empty CONTROL_TOKEN in .env with 24 random bytes as hex. The line is matched as text
# (nothing sourced); a non-empty value stays, and a missing line is not added. Never printed.
# @spec DEPLOY-INST-013
fill_control_token() {
  local tok
  grep -Eq '^CONTROL_TOKEN=[[:space:]]*(#.*)?$' .env || return 0
  tok=$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')
  sed -i -E "s#^CONTROL_TOKEN=[[:space:]]*(\#.*)?\$#CONTROL_TOKEN=${tok}#" .env
  log "Generated CONTROL_TOKEN in .env (the dashboard asks for it)."
}
# end control-token
fill_control_token

# ---------------------------------------------------------------- deps + build  @spec DEPLOY-INST-012
log "Installing workspace dependencies"
# Frozen only, like CI and the Dockerfile: a lockfile mismatch stops here with pnpm's own error
# instead of silently rewriting pnpm-lock.yaml.
pnpm install --frozen-lockfile || die "pnpm install --frozen-lockfile failed (see the error above); fix pnpm-lock.yaml and re-run."
log "Typechecking"
pnpm typecheck

# ---------------------------------------------------------------- pull
if [[ $PULL -eq 1 ]]; then
  log "Pulling images (this is the slow part)"
  docker compose pull --ignore-buildable
  log "Starting ollama + model pull"
  docker compose up -d ollama models
  docker compose logs -f models &
  LOGPID=$!
  docker compose wait models >/dev/null 2>&1 || true
  kill $LOGPID 2>/dev/null || true
fi

# ---------------------------------------------------------------- smoke test  @spec DEPLOY-INST-007
# probe <name> <timeout-seconds> <command...>: poll until the command passes; a probe that never
# passes prints one failure line naming it and stops the installer.
probe() {
  local name=$1 timeout=$2 deadline; shift 2
  deadline=$((SECONDS + timeout))
  until "$@" >/dev/null 2>&1; do
    (( SECONDS < deadline )) || die "smoke probe failed: $name did not pass within ${timeout}s"
    sleep 1
  done
  echo "  $name ok"
}
# Each attempt is bounded (timeout / --max-time) so a stalled command cannot starve the deadline check.
probe_redis()    { [[ "$(timeout 10 docker compose exec -T redis redis-cli ping)" == *PONG* ]]; }
probe_postgres() { [[ "$(timeout 10 docker compose exec -T postgres pg_isready -U cohost)" == *accepting* ]]; }
probe_ollama()   { [[ "$(curl -sf --max-time 5 http://127.0.0.1:11434/api/tags)" == *models* ]]; }

log "Smoke test"
docker compose up -d redis postgres
probe redis 60 probe_redis
probe postgres 60 probe_postgres
if [[ $PULL -eq 1 ]]; then probe ollama 60 probe_ollama; fi

# ---------------------------------------------------------------- next steps  @spec DEPLOY-INST-008, DEPLOY-INST-011
# begin next-steps
# @spec DEPLOY-INST-008
print_next_steps() {
  # DASHBOARD_PORT for the URL: the calling shell wins (as in Compose), then .env. .env is
  # parsed with sed, never sourced, so nothing in it is executed.
  local port=${DASHBOARD_PORT:-}
  if [[ -z "$port" ]]; then
    port=$(sed -n 's/^[[:space:]]*DASHBOARD_PORT=//p' .env | tail -n 1 | tr -d '\r' \
      | sed -e 's/[[:space:]]#.*$//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e "s/^[\"']//" -e "s/[\"']\$//")
  fi
  [[ "$port" =~ ^[0-9]+$ ]] || port=3000
  cat <<EOF

Done. Next:
  1. Edit .env (Twitch token, Discord token, OBS password, AVATAR_DRIVER).
  2. pnpm dashboard                    # start the dashboard on this machine (it brings up the stack)
  3. open http://localhost:${port}     # enter CONTROL_TOKEN from .env when asked, press Launch
     (the dashboard's startup log shows the URL it actually listens on; it differs when PORT or DASHBOARD_HOST is set)
  4. docker compose --profile eyes --profile ears up -d   # when ready for vision + Discord voice

Dev loop without Docker for the TS services:
  docker compose up -d redis postgres ollama tts stt   # infra only
  pnpm dev                                             # all services with tsx watch
EOF
}
# end next-steps
print_next_steps
