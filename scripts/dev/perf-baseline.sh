#!/usr/bin/env bash
# One-command speech-path latency baseline (backlog item 6): real Kokoro TTS -> ears -> speaches STT ->
# salience -> cortex (Ollama) -> voice (Kokoro) -> mouth dry-run sink, then `cohostctl latency`.
# No Discord, OBS or accounts. Uses the GPU overlay when nvidia-smi works. Leaves the stack up; `--down` stops it.
# Modes: `http` (default) posts whole clips to the http source; `connector` registers a test connector `perf` and
# streams the clip onto audio.in.perf at real time, then silence, so ears closes the utterance itself and the samples
# carry an `endpoint` row (scripts/dev/perf-connector.ts, CTRL-LAT-030). Which source ears listens to is set through
# COHOST_ISOLATION, because a plain EARS_SOURCES variable has no effect (CFG-ISO-009).
# Usage: mise run perf:baseline -- [--mode connector|http] [--runs N] [--down]
set -euo pipefail
cd "$(dirname "$0")/../.."

RUNS=10; DOWN=0; MODE=http
while [ $# -gt 0 ]; do
  case "$1" in
    --runs) RUNS="$2"; shift 2 ;;
    --mode) MODE="$2"; shift 2 ;;
    --down) DOWN=1; shift ;;
    *) echo "usage: $0 [--mode connector|http] [--runs N] [--down]" >&2; exit 2 ;;
  esac
done
# @spec CTRL-LAT-030, CTRL-LAT-031
case "$MODE" in
  http) COHOST_ISOLATION='{"EARS_SOURCES":"[http]","MOUTH_DRYRUN_ENABLED":"true"}' ;;
  connector) COHOST_ISOLATION='{"EARS_SOURCES":"[perf]","MOUTH_DRYRUN_ENABLED":"true"}' ;;
  *) echo "usage: $0 [--mode connector|http] [--runs N] [--down]" >&2; exit 2 ;;
esac

[ -f .env ] || { cp .env.example .env; echo "created .env from .env.example"; }

# Shell env beats .env for Compose, so nothing in .env needs editing.
export COMPOSE_PATH_SEPARATOR=:
export COMPOSE_FILE=docker-compose.yml
if nvidia-smi >/dev/null 2>&1; then COMPOSE_FILE=docker-compose.yml:docker-compose.gpu.yml; echo "GPU overlay on"; else echo "no GPU: numbers will not be representative"; fi
# The Kokoro GPU image (PyTorch) has no kernels for Blackwell cards (RTX 50xx: "no kernel image is available") and
# crash-loops, so TTS runs on the CPU image. The tts stage is therefore slower than a working GPU Kokoro would be.
export KOKORO_IMAGE="${KOKORO_IMAGE:-ghcr.io/remsky/kokoro-fastapi-cpu:v0.10.0}"
export COMPOSE_PROFILES=ears,mouth
export COHOST_ISOLATION

if [ "$DOWN" = 1 ]; then docker compose down; exit 0; fi

[ -d node_modules ] || pnpm install --frozen-lockfile

echo "== starting stack (first run pulls images and models: can take a long while)"
docker compose up -d --build
docker compose wait models >/dev/null 2>&1 || { echo "model pull failed: docker compose logs models" >&2; exit 1; }

STT_MODEL="$(grep -E '^STT_MODEL=' .env | cut -d= -f2 || true)"; STT_MODEL="${STT_MODEL:-Systran/faster-whisper-small}"
echo "== waiting for stt/tts, downloading $STT_MODEL"
until curl -sf -XPOST "localhost:8000/v1/models/$STT_MODEL" >/dev/null 2>&1; do sleep 3; done

DIR="$(mktemp -d)"; CLIP="$DIR/clip.wav"
echo "== making a speech clip"
for _ in $(seq 1 40); do curl -sf localhost:8880/v1/audio/speech -H 'content-type: application/json' \
  -d '{"model":"kokoro","input":"Hey, what do you think about this game so far?","voice":"af_heart","response_format":"wav"}' -o "$CLIP" && break; sleep 3; done
[ -s "$CLIP" ] || { echo "tts never answered: docker compose logs tts" >&2; exit 1; }

if [ "$MODE" = http ]; then docker compose cp "$CLIP" ears:/tmp/clip.wav >/dev/null; fi
send() {
  if [ "$MODE" = connector ]; then
    mise run -q perf:connector "$CLIP"
    return
  fi
  docker compose exec -T ears node -e '
    const fs=require("fs");
    fetch("http://127.0.0.1:8765/audio",{method:"POST",headers:{"content-type":"audio/wav"},body:fs.readFileSync("/tmp/clip.wav")})
      .then(r=>console.log("ears:",r.status));'
}

echo "== cold run (models loading), mode $MODE"
send; sleep 40
echo; echo "######## COLD (1 sample)"; mise run -q cohostctl latency --count 5000 || true

echo; echo "== $RUNS warm runs"
for i in $(seq 1 "$RUNS"); do send; sleep 15; done
echo; echo "######## ALL ($((RUNS + 1)) samples; first is cold)"; mise run -q cohostctl latency --count 5000
echo; echo "Stack still up. Stop it: scripts/dev/perf-baseline.sh --down"
