import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");

// @spec MEM-START-007, STORE-DLV-004
test("consolidate, reembed and reflect receive the memory unit's message, log a projection that does not load through their own logger and exit 1 without opening a store", () => {
  for (const name of ["consolidate", "reembed", "reflect"]) {
    const root = mkdtempSync(join(tmpdir(), `cohost-${name}-`));
    const config = join(root, "config");
    const data = join(root, "data");
    mkdirSync(config);
    writeFileSync(join(config, "settings.json"), JSON.stringify({ format: 1, unit: "memory", revision: 1, sections: { cohost: { name: "", streamer: "Chris" } }, documents: {} }));
    // The unit runner's pipe on descriptor 3, as a file holding the message.
    const message = join(root, "message.json");
    writeFileSync(message, JSON.stringify({ format: 1, unit: "memory", revision: 1, credentials: {} }));
    const fd = openSync(message, "r");
    const r = spawnSync(process.execPath, [join(repo, "services", "memory", "dist", `${name}.js`)], {
      cwd: join(repo, "services", "memory"), encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe", fd],
      env: {
        PATH: process.env.PATH, CONFIG_DIR: config, COHOST_DATA_DIR: data, COHOST_ENV_FILE: join(root, ".env"), COHOST_CREDENTIALS_FD: "3",
        DATABASE_URL: "postgres://cohost:cohost@127.0.0.1:1/none", OLLAMA_URL: "http://127.0.0.1:1",
      },
    });
    closeSync(fd);
    assert.equal(r.status, 1, `${name}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
    assert.match(r.stdout, new RegExp(`ERROR ${name}: Invalid .*settings\\.json:\\n {6}`), name);
    const entries = readFileSync(join(data, "logs", `${name}.log`), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.deepEqual(entries.map((e) => [e.level, e.name]), [[50, name]], `${name}: the config error is the only entry`);
    assert.match(String(entries[0]!.msg), /^Invalid .*settings\.json:\n {2}/);
    assert.doesNotMatch(r.stderr, /ECONNREFUSED|postgres|ollama/i, `${name} reached no store or model`);
  }
});
