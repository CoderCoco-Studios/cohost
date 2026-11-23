// The docs site's Rust bus example, examples/rust-bus/ (BUS-NAT-EX-*): its manifest, and its integration test, which
// needs Redis and skips itself without it. Skipped when `cargo` is not installed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const read = (rel: string) => readFileSync(root + rel, "utf8");
const hasCargo = spawnSync("cargo", ["--version"], { encoding: "utf8" }).status === 0;
const needsCargo = { skip: !hasCargo && "cargo is not installed" };

/** The lines of one `[section]` of a Cargo manifest, as a name -> value text map. */
function section(manifest: string, name: string): Map<string, string> {
  const out = new Map<string, string>();
  let inside = false;
  for (const raw of manifest.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[")) { inside = line === `[${name}]`; continue; }
    const m = inside ? /^([A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(line) : null;
    if (m) out.set(m[1]!, m[2]!);
  }
  return out;
}
const versionOf = (spec: string) => /^"([^"]+)"|version\s*=\s*"([^"]+)"/.exec(spec)?.slice(1).find(Boolean);

test("the example's dependencies are cohost-bus by path, tokio and serde_json at the crate's versions, and nothing else", () => { // @spec BUS-NAT-EX-001
  const example = read("examples/rust-bus/Cargo.toml");
  const deps = section(example, "dependencies");
  assert.deepEqual([...deps.keys()].sort(), ["cohost-bus", "serde_json", "tokio"]);
  assert.match(deps.get("cohost-bus")!, /path\s*=\s*"\.\.\/\.\.\/crates\/cohost-bus"/);
  const crate = section(read("crates/cohost-bus/Cargo.toml"), "dependencies");
  for (const name of ["tokio", "serde_json"]) {
    assert.ok(versionOf(crate.get(name)!), `the crate pins ${name}`);
    assert.equal(versionOf(deps.get(name)!), versionOf(crate.get(name)!), `${name} version`);
  }
  assert.ok(!/^\[(dev|build)-dependencies\]/m.test(example), "no dev- or build-dependencies");
});

test("the example's own tests pass (the round trip skips itself without Redis)", needsCargo, () => { // @spec BUS-NAT-EX-002, BUS-NAT-EX-003, BUS-NAT-EX-004, BUS-NAT-EX-005
  const r = spawnSync("cargo", ["test", "--manifest-path", "examples/Cargo.toml", "-p", "cohost-example-bus", "--", "--nocapture"], {
    cwd: root, encoding: "utf8", timeout: 570_000,
  });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.equal([...r.stdout.matchAll(/test result: ok\. 1 passed/g)].length, 2, "the unit test and the round trip each pass");
  // With REDIS_URL set (CI) the round trip must have run: a skip is a failure, never a silent pass.
  if (process.env["REDIS_URL"]) {
    assert.doesNotMatch(r.stderr, /SKIP /, "the round trip was skipped although REDIS_URL is set");
    assert.match(r.stderr, /RAN round_trip against /, "the round trip ran against Redis");
  }
  process.stderr.write(r.stderr.split("\n").filter((l) => /^(RAN|SKIP) /.test(l)).join("\n") + "\n");
});
