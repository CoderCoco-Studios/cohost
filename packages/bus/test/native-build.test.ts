// Build and load contract of the native addon (BUS-NAT-BLD-*): reads package.json and `native.ts`, and imports a copy of
// the built `dist/native.js` where the addon is missing. Needs no Redis.
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const nativeSrc = readFileSync(join(root, "packages/bus/src/native.ts"), "utf8");
const code = nativeSrc.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n"); // without comments

// @spec BUS-NAT-BLD-002
test("pnpm build and pnpm test run build:native, which builds the addon crate and copies the library, before tsc -b", () => {
  const { scripts } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts: Record<string, string> };
  assert.equal(
    scripts["build:native"],
    "cargo build --release -p cohost-bus-node && mkdir -p packages/bus/native && cp target/release/libcohost_bus_node.so packages/bus/native/cohost-bus.linux-x64-gnu.node",
  );
  for (const name of ["build", "test"]) {
    const steps = scripts[name]!.split("&&").map((s) => s.trim());
    const native = steps.indexOf("pnpm build:native");
    const tsc = steps.indexOf("tsc -b");
    assert.equal(native, 0, `${name} starts with pnpm build:native`);
    assert.ok(tsc > native, `${name} runs tsc -b after build:native`);
  }
});

// @spec BUS-NAT-BLD-004, BUS-NAT-BLD-006
test("native.ts loads the addon from one fixed relative path through createRequire, with no search path, env override or fallback; linux-x64 is the only target", () => {
  assert.match(code, /import \{ createRequire \} from "node:module"/);
  assert.match(code, /new URL\(`\.\.\/native\/\$\{file\}`, import\.meta\.url\)/);
  assert.match(code, /`cohost-bus\.\$\{platform\}-\$\{arch\}-gnu\.node`/);
  assert.equal((code.match(/createRequire\(/g) ?? []).length, 1, "one load site");
  assert.match(code, /createRequire\(import\.meta\.url\)\(path\)/);
  assert.ok(!/process\.env|require\.resolve|module\.paths|NODE_PATH|dlopen|process\.dlopen/.test(code), "no env override or search");
  assert.ok(!/readdirSync|existsSync|glob/.test(code), "no directory scan");
  // linux-x64-gnu only: any other platform or arch is refused before loading, and no other target is named
  assert.match(code, /platform !== "linux" \|\| arch !== "x64"/);
  assert.ok(!/darwin|win32|musl|arm64|aarch64|-msvc/.test(code), "no other target named");
});

// @spec BUS-NAT-BLD-005, BUS-NAT-BLD-006
test("importing the built native.js where the addon file is missing throws an error naming platform, arch, path and pnpm build:native", () => {
  const dir = mkdtempSync(join(tmpdir(), "native-missing-"));
  mkdirSync(join(dir, "dist"));
  cpSync(join(root, "packages/bus/dist/native.js"), join(dir, "dist/native.js")); // no ../native next to it
  const script = `import(${JSON.stringify(join(dir, "dist/native.js"))}).then(() => console.log(JSON.stringify({ ok: true })), (e) => console.log(JSON.stringify({ code: e.code, message: e.message })));`;
  const r = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 20_000 });
  assert.equal(r.status, 0, r.stderr);
  const res = JSON.parse(r.stdout) as { ok?: boolean; code?: string; message: string };
  assert.equal(res.ok, undefined, "the import failed");
  assert.equal(res.code, "BUS_INTERNAL");
  assert.ok(res.message.includes(`platform ${process.platform}`), res.message);
  assert.ok(res.message.includes(`arch ${process.arch}`), res.message);
  assert.ok(res.message.includes(join(dir, "native", `cohost-bus.${process.platform}-${process.arch}-gnu.node`)), res.message);
  assert.ok(res.message.includes("`pnpm build:native`"), res.message);
  // the only target is linux-x64-gnu: on this host the looked-for file is exactly that one
  if (process.platform === "linux" && process.arch === "x64") assert.ok(res.message.includes("cohost-bus.linux-x64-gnu.node"));
});
