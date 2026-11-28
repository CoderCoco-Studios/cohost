import { test } from "node:test";
import assert from "node:assert/strict";
import { openInBrowser, openerFor, wantsOpen, type OpenerHost, type Spawn } from "../src/opener.js";

const URL_ = "http://127.0.0.1:3000/unlock?n=SECRETNONCE";

const host = (platform: NodeJS.Platform, release: string, onPath: readonly string[] = []): OpenerHost =>
  ({ platform, osRelease: () => release, onPath: (cmd) => onPath.includes(cmd) });

// @spec DASH-UNL-014
test("the opener: wslview under WSL when it is on PATH, else cmd.exe /c start; xdg-open on other Linux; open on macOS", () => {
  assert.deepEqual(openerFor(host("linux", "6.18.33.1-microsoft-standard-WSL2", ["wslview"])), { cmd: "wslview", args: [] });
  assert.deepEqual(openerFor(host("linux", "6.18.33.1-microsoft-standard-WSL2")), { cmd: "cmd.exe", args: ["/c", "start", ""] });
  assert.deepEqual(openerFor(host("linux", "4.4.0-19041-Microsoft")), { cmd: "cmd.exe", args: ["/c", "start", ""] }, "WSL 1 names it with a capital");
  assert.deepEqual(openerFor(host("linux", "6.8.0-45-generic", ["wslview"])), { cmd: "xdg-open", args: [] });
  assert.deepEqual(openerFor(host("darwin", "24.1.0")), { cmd: "open", args: [] });
});

// @spec DASH-UNL-014
test("--open is asked for by the argument alone", () => {
  assert.equal(wantsOpen(["node", "index.js", "--open"]), true);
  assert.equal(wantsOpen(["node", "index.js"]), false);
  assert.equal(wantsOpen(["node", "index.js", "--opened"]), false);
});

// @spec DASH-UNL-014
test("the URL is passed to the opener once, as its last argument", async () => {
  const calls: [string, readonly string[]][] = [];
  const spawn: Spawn = async (cmd, args) => { calls.push([cmd, args]); return { code: 0 }; };
  const warnings: string[] = [];
  await openInBrowser(URL_, { host: host("linux", "6.18.33.1-microsoft-standard-WSL2"), spawn, warn: (m) => warnings.push(m) });
  assert.deepEqual(calls, [["cmd.exe", ["/c", "start", "", URL_]]]);
  assert.deepEqual(warnings, []);
});

// @spec DASH-UNL-015
test("an opener that cannot be started or exits non-zero is one warning naming the opener and not the URL", async () => {
  for (const outcome of [{ error: new Error("spawn xdg-open ENOENT") }, { code: 3 }, { code: null, signal: "SIGKILL" }] as const) {
    const warnings: string[] = [];
    await openInBrowser(URL_, { host: host("linux", "6.8.0-generic"), spawn: async () => outcome, warn: (m) => warnings.push(m) });
    assert.equal(warnings.length, 1, JSON.stringify(outcome));
    assert.match(warnings[0]!, /xdg-open/);
    assert.ok(!warnings[0]!.includes("SECRETNONCE") && !warnings[0]!.includes("/unlock"), "never the link");
  }
});

// @spec DASH-UNL-015
test("a platform with no opener is one warning, and nothing is spawned", async () => {
  const warnings: string[] = [];
  let spawned = 0;
  await openInBrowser(URL_, { host: host("win32", "10.0"), spawn: async () => { spawned++; return { code: 0 }; }, warn: (m) => warnings.push(m) });
  assert.equal(spawned, 0);
  assert.equal(warnings.length, 1);
  assert.ok(!warnings[0]!.includes("SECRETNONCE"));
});
