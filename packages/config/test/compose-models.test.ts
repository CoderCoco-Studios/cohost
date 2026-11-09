import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

// Structural + behavioural checks of the compose `models` one-shot. Docker is not needed: the
// service command is extracted from docker-compose.yml, de-escaped (`$$` -> `$`, as Compose does)
// and run under `sh` against a fake `curl` that stands in for Ollama.

const composePath = fileURLToPath(new URL("../../../docker-compose.yml", import.meta.url));
const compose = parse(readFileSync(composePath, "utf8")) as {
  services: Record<string, { command?: string[]; restart?: string }>;
};
const models = compose.services.models!;
const script = models.command!.join("\n");

interface RunResult { status: number | null; stderr: string; pulled: string[] }

function runModels(env: Record<string, string>, failing: string[]): RunResult {
  const dir = mkdtempSync(join(tmpdir(), "models-"));
  const log = join(dir, "pulled.log");
  writeFileSync(log, "");
  // Fake curl: /api/tags answers; /api/pull logs the model and fails when it is listed in
  // FAIL_MODELS: an HTTP error (exit 22) for names starting "http", else a mid-stream "error" line.
  writeFileSync(join(dir, "curl"), `#!/bin/sh
url=""; data=""; out=""
while [ $# -gt 0 ]; do
  case "$1" in
    -d) data="$2"; shift 2;;
    -o) out="$2"; shift 2;;
    http*) url="$1"; shift;;
    *) shift;;
  esac
done
case "$url" in
  */api/tags) exit 0;;
esac
m=$(printf '%s' "$data" | sed 's/.*"name":"\\([^"]*\\)".*/\\1/')
echo "$m" >> "$PULL_LOG"
case " $FAIL_MODELS " in
  *" $m "*)
    case "$m" in
      http*) echo "boom" > "$out"; exit 22;;
      *) echo '{"status":"pulling"}' > "$out"; echo '{"error":"mid-stream failure"}' >> "$out"; exit 0;;
    esac;;
esac
echo '{"status":"success"}' > "$out"
`);
  chmodSync(join(dir, "curl"), 0o755);
  const r = spawnSync("sh", ["-c", script.replaceAll("$$", "$")], {
    env: { PATH: `${dir}:${process.env.PATH}`, PULL_LOG: log, FAIL_MODELS: failing.join(" "), ...env },
    encoding: "utf8",
  });
  const pulled = readFileSync(log, "utf8").split("\n").filter(Boolean);
  return { status: r.status, stderr: r.stderr, pulled };
}

const base = { LLM_MODEL: "llm:1", VISION_MODEL: "vis:1", EMBED_MODEL: "emb:1" };

// @spec DEPLOY-COMPOSE-008
test("models service pulls LLM, vision, embed and notes models, notes defaulting to gemma3:4b", () => {
  assert.match(script, /\$\$\{NOTES_MODEL:-gemma3:4b\}/);
  assert.doesNotMatch(script, /STT_MODEL/);
  const unset = runModels(base, []);
  assert.equal(unset.status, 0);
  assert.deepEqual(unset.pulled, ["llm:1", "vis:1", "emb:1", "gemma3:4b"]);
  const empty = runModels({ ...base, NOTES_MODEL: "" }, []);
  assert.equal(empty.pulled.at(-1), "gemma3:4b");
  const custom = runModels({ ...base, NOTES_MODEL: "gemma3:12b" }, []);
  assert.deepEqual(custom.pulled, ["llm:1", "vis:1", "emb:1", "gemma3:12b"]);
});

// @spec DEPLOY-COMPOSE-011
test("a failed LLM, vision or embed pull still exits non-zero after trying every model", () => {
  for (const bad of ["llm:1", "vis:1", "emb:1"]) {
    const r = runModels(base, [bad]); // mid-stream "error" line
    assert.equal(r.status, 1, bad);
    assert.equal(r.pulled.length, 4, `${bad}: every model attempted`);
    assert.match(r.stderr, new RegExp(`pull FAILED: ${bad}`));
  }
  const http = runModels({ ...base, LLM_MODEL: "http-llm" }, ["http-llm"]); // curl HTTP error
  assert.equal(http.status, 1);
});

// @spec DEPLOY-COMPOSE-011
test("a failed notes-model pull is a warning and leaves the exit status at 0", () => {
  const midstream = runModels(base, ["gemma3:4b"]);
  assert.equal(midstream.status, 0);
  assert.match(midstream.stderr, /WARNING.*gemma3:4b/);
  const http = runModels({ ...base, NOTES_MODEL: "http-notes" }, ["http-notes"]);
  assert.equal(http.status, 0);
  assert.match(http.stderr, /WARNING/);
  // a required-model failure still wins when the notes pull also fails
  assert.equal(runModels(base, ["llm:1", "gemma3:4b"]).status, 1);
});

// @spec DEPLOY-COMPOSE-011
test("the models service carries no restart policy", () => {
  assert.equal(models.restart, undefined);
});
