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

# ---------------------------------------------------------------- system prerequisites  @spec DEPLOY-TOOL-004
# curl and ca-certificates fetch mise; gnupg verifies its signed checksums; libatomic1 is loaded by the Node binary. Nothing else is installed system-wide
# for the project's toolchains: those come from mise.toml, per project.
need_apt=()
command -v curl >/dev/null 2>&1 || need_apt+=(curl)
command -v gpg >/dev/null 2>&1 || need_apt+=(gnupg)
[[ -f /etc/ssl/certs/ca-certificates.crt ]] || need_apt+=(ca-certificates)
# The official Node binary mise installs links libatomic.so.1 dynamically, and mise cannot provide a system library.
# grep reads the cache through a process substitution, not a pipe: under pipefail, grep -q stopping at the first
# match would end a long ldconfig listing with SIGPIPE (141) and libatomic would read as missing.
ldcache() { /sbin/ldconfig -p 2>/dev/null || ldconfig -p 2>/dev/null; }
grep -q 'libatomic\.so\.1 ' < <(ldcache) || need_apt+=(libatomic1)
if [[ ${#need_apt[@]} -gt 0 ]]; then
  log "Installing ${need_apt[*]}"
  sudo apt-get update -qq
  sudo apt-get install -y -qq "${need_apt[@]}"
fi

# ---------------------------------------------------------------- mise and the toolchains  @spec DEPLOY-INST-004, DEPLOY-INST-009, DEPLOY-INST-014
# mise is one per-user binary, ~/.local/bin/mise, at the release mise.toml's min_version names, and is always run
# by its full path, so an older mise elsewhere on the path is never used. It installs Node, pnpm, Rust (from
# rust-toolchain.toml), Zig, Python and watchexec per project from mise.lock; no version of any of them is named here.
# begin mise-setup
MISE="$HOME/.local/bin/mise"
# The release mise.toml's min_version names, read as text (mise may not exist yet).
mise_min_version() { sed -n 's/^min_version[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' mise.toml | head -n 1; }
# ensure_mise: unless ~/.local/bin/mise is that release, fetch and verify it (scripts/fetch-mise.sh, DEPLOY-TOOL-020).
ensure_mise() {
  local want have
  want=$(mise_min_version)
  [[ -n "$want" ]] || die "cannot read min_version from mise.toml"
  have=$("$MISE" --version 2>/dev/null | awk '{ print $1 }' || true)
  if [[ "$have" == "$want" ]]; then
    log "mise $want is installed ($MISE)"
    return 0
  fi
  log "Installing mise $want to $MISE (signature and checksum verified)"
  "$ROOT/scripts/fetch-mise.sh" "$want" "$MISE" || die "installing mise $want failed (see the message above)"
}
# end mise-setup
ensure_mise
"$MISE" trust "$ROOT/mise.toml" || die "mise trust failed for $ROOT/mise.toml"
log "Installing the project's toolchains (mise install --locked)"
"$MISE" install --locked || die "mise install --locked failed (see the error above)"
# From here on, node, pnpm and cargo are the ones mise.toml selects, whatever the host has on its path.
eval "$("$MISE" activate bash --shims)"

# begin shell-activate
# Add the mise activate line to the login shell's rc file, so a new shell gets the project's tools and tasks.
# @spec DEPLOY-INST-016
activate_shell() {
  local shell_name rc line
  shell_name=$(basename "${SHELL:-}")
  case "$shell_name" in
    zsh) rc="$HOME/.zshrc" ;;
    bash) rc="$HOME/.bashrc" ;;
    *)
      log "Add this line to your shell's startup file so it activates mise (replace <shell> with your shell's name):"
      echo "  eval \"\$(~/.local/bin/mise activate <shell>)\""
      return 0
      ;;
  esac
  line="eval \"\$(~/.local/bin/mise activate $shell_name)\""
  if [[ -f "$rc" ]] && grep -q 'mise activate' "$rc"; then
    return 0
  fi
  printf '\n# mise: per-project toolchains and tasks (added by cohost scripts/install.sh)\n%s\n' "$line" >>"$rc"
  log "Added the mise activate line to $rc (open a new shell for it to apply)"
}
# end shell-activate
activate_shell

# ---------------------------------------------------------------- .env  @spec DEPLOY-INST-005, DEPLOY-INST-006
# begin seed-files
# Copies .env from its template when it is missing and never overwrites one that exists. No settings, personality,
# expressions or credentials file is written: the settings store is created and seeded from the committed examples at its first
# open (mise run config:project below).
# @spec DEPLOY-INST-005
seed_files() {
  if [[ ! -f .env ]]; then
    cp .env.example .env
    log "Wrote .env from its template: the dashboard's access controls and Compose settings."
  fi
  # Every program's log file lives in data/logs; made here as the user running the installer, so Compose never creates it as root.
  mkdir -p data/logs  # @spec DEPLOY-INST-017
}
# end seed-files
seed_files
if [[ $HAS_NVIDIA -eq 1 ]]; then
  sed -i 's#^COMPOSE_FILE=.*#COMPOSE_FILE=docker-compose.yml:docker-compose.gpu.yml#' .env
  log "GPU overlay enabled in .env (COMPOSE_FILE)"
else
  sed -i 's#^COMPOSE_FILE=.*#COMPOSE_FILE=docker-compose.yml#' .env
fi
mkdir -p data

# begin control-token
# The control token is cohost's one lock and the owner keeps it: the settings store holds only its verifier, and .env never
# holds it (the dashboard and the control plane refuse a CONTROL_TOKEN there). A .env line holding a value is reported by its
# line number, never its value, and left for the owner to remove once the token is kept elsewhere
# (`mise run config:token -- --stdin` keeps the same token). The line is matched as text (nothing sourced).
# @spec DEPLOY-INST-013
warn_env_token() {
  local n val
  n=$(grep -nE '^[[:space:]]*(export[[:space:]]+)?CONTROL_TOKEN[[:space:]]*=' .env 2>/dev/null | head -1 | cut -d: -f1) || true
  [[ -n "$n" ]] || return 0
  val=$(sed -n "${n}p" .env | sed -E 's/^[^=]*=//; s/[[:space:]]+#.*$//; s/^[[:space:]]+//; s/[[:space:]]+$//; s/^"(.*)"$/\1/; s/^'"'"'(.*)'"'"'$/\1/; s/^[[:space:]]+//; s/[[:space:]]+$//')
  if [[ -n "$val" ]]; then
    warn ".env defines CONTROL_TOKEN on line ${n}: remove that line once the token is in your password manager (mise run config:token -- --stdin sets the same token in the settings store). The dashboard and the control plane refuse to start anything while it is there."
  fi
}

# Sets a control token when the settings store holds none: the token is printed once, straight to the owner's terminal, and
# written to no file and no log. A store that already holds a verifier is left alone.
set_control_token() {
  log "Setting the control token when none is set (mise run config:token -- --if-unset)"
  "$MISE" run config:token -- --if-unset || die "mise run config:token failed (see the message above)."
}
# end control-token
warn_env_token

# ---------------------------------------------------------------- build  @spec DEPLOY-INST-007, DEPLOY-INST-012, DEPLOY-INST-014
# One task builds everything: its install dependency runs pnpm install --frozen-lockfile (a lockfile mismatch
# stops here with pnpm's own error, never a non-frozen install, like CI and the Dockerfile), then the bus addon
# (Rust linked through Zig, both from mise.toml), tsc -b and the dashboard UI.
log "Building the workspace (mise run build)"
"$MISE" run build || die "mise run build failed (see the error above); a pnpm-lock.yaml mismatch is fixed in the repository, never by a non-frozen install."
# The first task that opens the settings store creates it (seeded from the committed examples) and the master key when they
# are missing, printing the recovery key once; it writes one projection per service under data/projections/, so every
# directory Compose mounts exists before any Compose command.
# @spec DEPLOY-INST-007, DEPLOY-INST-013
log "Writing the settings projections (mise run config:project)"
"$MISE" run config:project || die "mise run config:project failed (see the message above); mise run config:check lists what stops the settings store."
set_control_token
# The docs the dashboard serves. A failure is a warning: the dashboard still starts and shows a not-built page.
# @spec DEPLOY-INST-015
log "Building the docs site (mise run docs:build)"
"$MISE" run docs:build || warn "mise run docs:build failed (see above); the dashboard serves a 'docs not built' page until it succeeds. Continuing."

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
  # The dashboard's port is dashboard.port as the settings store's own task prints it; the installer never reads the store's
  # file itself. When the task fails its first error line goes to stderr and the URL carries no port.
  local url="http://localhost" port_note="" port shell_name out errf
  errf=$(mktemp)
  shell_name=$(basename "${SHELL:-}")
  case "$shell_name" in zsh|bash) ;; *) shell_name="<shell>" ;; esac
  if out=$(cd "$ROOT" && "$MISE" run -q config:get -- dashboard.port 2>"$errf") && port=$(printf '%s\n' "$out" | grep -E '^[0-9]+$' | tail -1) && [[ -n "$port" ]]; then
    url="http://localhost:${port}"
  else
    head -1 "$errf" >&2 2>/dev/null || true
    port_note="     (mise run config:get -- dashboard.port failed, see above; the dashboard's own start output shows the address it listens on)"
  fi
  rm -f "$errf"
  cat <<EOF

Done. Next:
  0. Open a new shell, so the mise activate line applies and the project's tools and tasks are on its path,
     or activate mise in this one:  eval "\$(~/.local/bin/mise activate ${shell_name})"
  1. Keep the recovery key and the control token printed above in your password manager.
  2. mise run dashboard                # start the dashboard on this machine (it brings up the stack)
  3. open the unlock link the dashboard prints (or ${url} and enter the control token when asked), set your
     values on the Settings screen (models, voice, Twitch channel, OBS host, API keys, ...), then press Launch
${port_note:+${port_note}
}     (the dashboard's startup log shows the URL it actually listens on; it differs when DASHBOARD_HOST is set)
  4. docker compose --profile eyes --profile ears --profile mouth --profile discord up -d
     # when ready for vision (eyes), listening (ears), speaking (mouth) and Discord (the Discord connector)
     # the one Discord bot is the credential connections.discord.token (the dashboard's Settings screen or
     # mise run config:secret -- connections.discord.token), used by the Discord connector; ears and mouth need no token
     # a hand-run docker compose up starts services that wait for their credentials until the dashboard delivers them
     # (or mise run deliver); run mise run config:project first so they read the current settings
  5. optional speech engines: to use the pocket TTS (voice.engine: pocket) or a streaming STT server (ears.stt_engine:
     nemotron or kyutai), add pocket, nemotron or kyutai to COMPOSE_PROFILES in .env (for example COMPOSE_PROFILES=pocket,nemotron),
     select it on the Settings screen, then press Launch again. The first build of an enabled profile takes minutes; later launches reuse it.

Dev loop without Docker for the TS services:
  mise run infra:up                       # the infrastructure containers: redis postgres ollama tts stt
  mise run dev                            # every service, rebuilt and restarted when its code changes
  mise watch --restart dev:<service>      # or one service, e.g. dev:cortex

Check this machine's system prerequisites (Docker, the GPU runtime, git, curl, glibc) at any time:
  mise run doctor
EOF
}
# end next-steps
print_next_steps
