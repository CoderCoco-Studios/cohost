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

// @spec CTRL-LAT-030, CTRL-LAT-031
test("both modes carry the mouth dry-run preset in COHOST_ISOLATION, with no plain MOUTH_DRYRUN_ENABLED export", () => {
  const s = script();
  assert.match(s, /COHOST_ISOLATION='\{"EARS_SOURCES":"\[http\]","MOUTH_DRYRUN_ENABLED":"true"\}'/, "http mode");
  assert.match(s, /COHOST_ISOLATION='\{"EARS_SOURCES":"\[perf\]","MOUTH_DRYRUN_ENABLED":"true"\}'/, "connector mode");
  assert.doesNotMatch(s, /export\s+MOUTH_DRYRUN_ENABLED/, "no plain export");
  assert.doesNotMatch(s, /export\s+EARS_SOURCES/, "no plain export of the source list");
});

// @spec CTRL-LAT-030
test("the connector helper registers through ConnectorRegistrar, publishes frames with publishFrame(\"in\", ...) at 16000 Hz, and deregisters on SIGINT", () => {
  const helper = readFileSync(join(root, "scripts", "dev", "perf-connector.ts"), "utf8");
  assert.match(helper, /new ConnectorRegistrar\(/, "registers through the bus registrar");
  assert.match(helper, /publishFrame\("in",\s*tag,/, "writes frames on the inbound stream");
  assert.match(helper, /const RATE = 16000;/, "16000 constant");
  assert.match(helper, /rate: RATE, ch: 1/, "frames carry the RATE constant");
  assert.match(helper, /process\.once\("SIGINT"/, "SIGINT deregisters the connector");
  assert.match(helper, /registrar\.stop\(\)/, "deregisters through the registrar");
});
