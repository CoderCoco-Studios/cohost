import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const script = (): string => readFileSync(join(root, "scripts", "dev", "perf-baseline.sh"), "utf8");

// @spec CTRL-LAT-030
test("perf-baseline.sh has a connector mode run by a tsx helper that writes frames to audio.in.perf, selecting [perf] through COHOST_ISOLATION", () => {
  const s = script();
  assert.match(s, /connector/i, "a connector mode");
  assert.ok(existsSync(join(root, "scripts", "dev", "perf-connector.ts")), "scripts/dev/perf-connector.ts exists");
  assert.match(s, /perf-connector\.ts/, "the script runs the helper");
  assert.match(s, /COHOST_ISOLATION=.*EARS_SOURCES.*\[perf\]/, "ears.sources selected through COHOST_ISOLATION, not a plain env var (CFG-ISO-009)");
  const helper = readFileSync(join(root, "scripts", "dev", "perf-connector.ts"), "utf8");
  assert.match(helper, /audio\.in\.perf|audio\.in\.\$\{/, "writes onto audio.in.<tag>");
  assert.match(helper, /16000/, "16 kHz mono frames");
});

// @spec CTRL-LAT-031
test("perf-baseline.sh keeps an http mode that posts whole clips to the http source", () => {
  const s = script();
  assert.match(s, /\bhttp\b/);
  assert.match(s, /127\.0\.0\.1:8765\/audio/, "posts a whole clip to the http source");
});
