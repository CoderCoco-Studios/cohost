import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { parse } from "yaml";
import { ConfigSchema } from "../src/index.js";

const repo = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
const baseCfg = () => ({
  cohost: { name: "a", streamer: "b" }, llm: { model: "m", embed_model: "e" }, vision: { model: "v", obs: {} }, chat: { twitch: {} },
  voice: {}, avatar: { vtube_studio: { host: "h" }, vmc: { host: "h" } }, ears: {}, dashboard: {}, brain: {},
});
const outputs = (o: Record<string, unknown>) => ConfigSchema.safeParse({ ...baseCfg(), mouth: { outputs: o } });
const failsOn = (r: ReturnType<typeof outputs>, key: string) => !r.success && r.error.issues.some((i) => i.path.join(".") === key);

// @spec CFG-SCH-031
test("mouth.outputs.file defaults to disabled, mouth/outputs and 100 files; dir must be relative with no `..`; max_files is an integer of 1 or more", () => {
  assert.deepEqual(outputs({}).data!.mouth.outputs.file, { enabled: false, dir: "mouth/outputs", max_files: 100 });
  assert.deepEqual(outputs({ file: { enabled: true, dir: "archive/lines", max_files: 5 } }).data!.mouth.outputs.file, { enabled: true, dir: "archive/lines", max_files: 5 });
  for (const dir of ["/etc", "../x", "a/../../b", "a/..", ""]) assert.ok(failsOn(outputs({ file: { dir } }), "mouth.outputs.file.dir"), `dir ${JSON.stringify(dir)}`);
  for (const max_files of [0, -1, 1.5, "3"]) assert.ok(failsOn(outputs({ file: { max_files } }), "mouth.outputs.file.max_files"), `max_files ${String(max_files)}`);
  assert.equal(outputs({ file: { enabled: "yes" } }).success, false);
});

// @spec CFG-SCH-031
test("mouth.outputs.http defaults to disabled with an empty url, 5000 ms, 3 retries and a queue of 20; url must be empty or http(s); numbers are validated by name", () => {
  assert.deepEqual(outputs({}).data!.mouth.outputs.http, { enabled: false, url: "", timeout_ms: 5000, retries: 3, max_queue: 20 });
  assert.equal(outputs({ http: { enabled: true, url: "https://sink.example/in" } }).data!.mouth.outputs.http.url, "https://sink.example/in");
  assert.equal(outputs({ http: { retries: 0 } }).success, true);
  for (const url of ["ftp://x", "sink.example/in", "file:///etc/passwd"]) assert.ok(failsOn(outputs({ http: { url } }), "mouth.outputs.http.url"), url);
  for (const timeout_ms of [0, -5, 1.5]) assert.ok(failsOn(outputs({ http: { timeout_ms } }), "mouth.outputs.http.timeout_ms"), String(timeout_ms));
  for (const retries of [-1, 1.5]) assert.ok(failsOn(outputs({ http: { retries } }), "mouth.outputs.http.retries"), String(retries));
  for (const max_queue of [0, -1, 2.5]) assert.ok(failsOn(outputs({ http: { max_queue } }), "mouth.outputs.http.max_queue"), String(max_queue));
});

// @spec CFG-USR-014
test("the shipped example sets the file and http outputs to literals, with the other keys at their defaults and a comment on each key", () => {
  const example = readFileSync(join(repo, "config", "config.example.yaml"), "utf8");
  const block = example.slice(example.indexOf("\n    file:"), example.indexOf("\n  fallback:\n    min_interval_ms"));
  assert.doesNotMatch(block, /\$\{/);
  assert.match(block, /file:[^\n]*\n\s+enabled: false\s+#/);
  assert.match(block, /http:[^\n]*\n\s+enabled: false\s+#/);
  assert.match(block, /url: ""\s+#/);
  for (const line of block.split("\n").filter((l) => /^\s{6}[a-z_]+:/.test(l))) assert.match(line, /#/, `a comment on: ${line.trim()}`);
  const env = readFileSync(join(repo, ".env.example"), "utf8");
  for (const name of ["MOUTH_FILE_ENABLED", "MOUTH_HTTP_ENABLED", "MOUTH_HTTP_URL"]) assert.doesNotMatch(env, new RegExp(name), name);
  const text = parse(example) as { mouth: { outputs: Record<string, Record<string, unknown>> } };
  const parsed = ConfigSchema.parse({ ...baseCfg(), mouth: text.mouth });
  assert.deepEqual(parsed.mouth.outputs.file, { enabled: false, dir: "mouth/outputs", max_files: 100 });
  assert.deepEqual(parsed.mouth.outputs.http, { enabled: false, url: "", timeout_ms: 5000, retries: 3, max_queue: 20 });
});
