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

# ---------------------------------------------------------------- detect env
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

# ---------------------------------------------------------------- docker
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
  warn "Added $USER to the docker group — log out/in (or run 'newgrp docker') if docker commands fail."
fi
docker compose version >/dev/null 2>&1 || die "docker compose plugin missing"

# ---------------------------------------------------------------- nvidia container toolkit
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

# ---------------------------------------------------------------- node + pnpm (for local dev)
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | cut -c2-3)" -lt 22 ]]; then
  log "Installing Node 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - >/dev/null
  sudo apt-get install -y -qq nodejs
fi
command -v pnpm >/dev/null 2>&1 || { log "Enabling pnpm via corepack"; sudo corepack enable; corepack prepare pnpm@10.0.0 --activate; }

# ---------------------------------------------------------------- .env
if [[ ! -f .env ]]; then
  cp .env.example .env
  log "Wrote .env from template — fill in Twitch/Discord/OBS values."
fi
if [[ ! -f config/config.yaml ]]; then
  cp config/config.example.yaml config/config.yaml
  log "Wrote config/config.yaml from config.example.yaml — this one is yours (git-ignored)."
fi
if [[ $HAS_NVIDIA -eq 1 ]]; then
  sed -i 's#^COMPOSE_FILE=.*#COMPOSE_FILE=docker-compose.yml:docker-compose.gpu.yml#' .env
  log "GPU overlay enabled in .env (COMPOSE_FILE)"
else
  sed -i 's#^COMPOSE_FILE=.*#COMPOSE_FILE=docker-compose.yml#' .env
fi
mkdir -p data

# ---------------------------------------------------------------- deps + build
log "Installing workspace dependencies"
pnpm install --frozen-lockfile 2>/dev/null || pnpm install
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

# ---------------------------------------------------------------- smoke test
log "Smoke test"
docker compose up -d redis postgres
sleep 2
docker compose exec -T redis redis-cli ping | grep -q PONG && echo "  redis ok"
docker compose exec -T postgres pg_isready -U cohost | grep -q accepting && echo "  postgres ok"
if [[ $PULL -eq 1 ]]; then
  curl -sf http://127.0.0.1:11434/api/tags | grep -q models && echo "  ollama ok"
fi

cat <<EOF

Done. Next:
  1. Edit .env (Twitch token, Discord token, OBS password, AVATAR_DRIVER).
  2. docker compose up -d            # core stack
  3. open http://localhost:${DASHBOARD_PORT:-3000}   # dashboard: bus feed, audio sink, personality editor
  4. docker compose --profile eyes --profile ears up -d   # when ready for vision + Discord voice

Dev loop without Docker for the TS services:
  docker compose up -d redis postgres ollama tts   # infra only
  pnpm dev                                         # all services with tsx watch
EOF
