#!/bin/sh
# Check the host's system prerequisites: the things a checkout needs that cannot be scoped to the project
# (deployment design, "System prerequisites"). It prints one line per check, ✓ or ✗, and for each ✗ the
# command that installs or fixes it. It installs nothing. It exits non-zero when any check fails; the glibc
# check only warns.
#   scripts/doctor.sh                 # every check (the doctor task)
#   scripts/doctor.sh docker|gpu|fetch|glibc   # one check (the doctor:<check> tasks)
# @spec DEPLOY-TOOL-017
set -u

# The oldest supported host: Ubuntu 22.04, glibc 2.35 (mise.toml ZIG_GLIBC links the bus addon against it).
GLIBC_FLOOR=2.35

failed=0
pass() { printf '✓ %s\n' "$1"; }
fail() { printf '✗ %s\n    fix: %s\n' "$1" "$2"; failed=1; }
warn() { printf '! %s\n' "$1"; }
is_wsl() { grep -qi microsoft /proc/version 2>/dev/null; }

check_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    if is_wsl; then
      fail "docker is not on the path" "install Docker Desktop for Windows and turn on Settings > Resources > WSL integration for this distro (or run scripts/install.sh to install docker-ce in the distro)"
    else
      fail "docker is not on the path" "scripts/install.sh   (installs docker-ce and the Compose plugin from Docker's apt repository)"
    fi
    return
  fi
  pass "docker is on the path"
  if docker compose version >/dev/null 2>&1; then
    pass "docker compose works"
  elif is_wsl && ! command -v apt-get >/dev/null 2>&1; then
    fail "docker compose version failed" "update Docker Desktop, which ships the Compose plugin"
  else
    fail "docker compose version failed" "sudo apt-get install -y docker-compose-plugin"
  fi
  if err=$(docker info 2>&1 >/dev/null); then
    pass "the Docker daemon answers"
  elif printf '%s' "$err" | grep -qi 'permission denied'; then
    fail "the Docker daemon refuses this user" "sudo usermod -aG docker \"\$USER\", then log out and back in"
  elif is_wsl; then
    fail "the Docker daemon does not answer" "start Docker Desktop (or, for docker-ce in the distro: sudo service docker start)"
  else
    fail "the Docker daemon does not answer" "sudo systemctl start docker"
  fi
}

check_gpu() {
  if ! command -v nvidia-smi >/dev/null 2>&1 || ! nvidia-smi -L >/dev/null 2>&1; then
    pass "no NVIDIA GPU reported by nvidia-smi, so no NVIDIA container runtime is needed (the stack runs CPU-only)"
    return
  fi
  if ! command -v docker >/dev/null 2>&1; then
    fail "nvidia-smi reports a GPU but docker is not on the path" "see the docker check (mise run doctor:docker)"
    return
  fi
  if docker info 2>/dev/null | grep -qi nvidia; then
    pass "Docker lists the NVIDIA runtime"
  elif is_wsl && ! command -v nvidia-ctk >/dev/null 2>&1 && docker info 2>/dev/null | grep -qi 'docker desktop'; then
    fail "nvidia-smi reports a GPU but Docker lists no NVIDIA runtime" "update Docker Desktop and the NVIDIA Windows driver (Docker Desktop provides GPU support through WSL2)"
  else
    fail "nvidia-smi reports a GPU but Docker lists no NVIDIA runtime" "scripts/install.sh   (installs nvidia-container-toolkit), or: sudo nvidia-ctk runtime configure --runtime=docker && sudo systemctl restart docker"
  fi
}

check_fetch() {
  for tool in git curl; do
    if command -v "$tool" >/dev/null 2>&1; then
      pass "$tool is on the path"
    else
      fail "$tool is not on the path" "sudo apt-get install -y $tool"
    fi
  done
}

# version_lt <a> <b>: true when dotted version a is older than b.
version_lt() {
  [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -n 1)" = "$1" ]
}

check_glibc() {
  have=$(getconf GNU_LIBC_VERSION 2>/dev/null | awk '{ print $2 }')
  if [ -z "$have" ]; then
    warn "could not read the host's glibc version; the supported floor is glibc $GLIBC_FLOOR (Ubuntu 22.04)"
  elif version_lt "$have" "$GLIBC_FLOOR"; then
    warn "the host's glibc $have is older than the supported floor $GLIBC_FLOOR (Ubuntu 22.04); the bus addon may not load here"
  else
    pass "glibc $have is at least the supported floor $GLIBC_FLOOR"
  fi
}

if [ $# -eq 0 ]; then set -- docker gpu fetch glibc; fi
for check do
  case $check in
    docker) check_docker ;;
    gpu) check_gpu ;;
    fetch) check_fetch ;;
    glibc) check_glibc ;;
    *) echo "usage: $0 [docker|gpu|fetch|glibc]..." >&2; exit 2 ;;
  esac
done
exit "$failed"
