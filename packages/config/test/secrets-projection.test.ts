import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { projectSecrets, SECRET_PATHS } from "../src/index.js";

// The per-unit secrets projection (deployment DEPLOY-SECRET-003, -005, -007, -009, -010; config CFG-SEC-019): the one operator
// file `secrets/secrets.yaml` is read with the loader's rules and each unit gets a file holding only the paths it declares.
// `projectSecrets(root, units)` takes the workspace root and `{ composeName, secrets }` per unit and rejects with an error that
// names a file, directory or path and never a value.

const initial = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in initial)) delete process.env[k];
  Object.assign(process.env, initial);
});

const MARKER = "sk-PROJECTION-MARKER";
/** A workspace root holding `secrets/secrets.yaml` with `operator` (mode 0600); the loader is pointed at it. */
function workspace(operator?: string): { root: string; operator: string; units: string } {
  const root = mkdtempSync(join(tmpdir(), "cohost-proj-"));
  mkdirSync(join(root, "secrets"), { mode: 0o700 });
  const file = join(root, "secrets", "secrets.yaml");
  if (operator !== undefined) writeFileSync(file, operator, { mode: 0o600 });
  process.env.COHOST_SECRETS_FILE = file;
  return { root, operator: file, units: join(root, "secrets", "units") };
}
const unitFile = (w: { units: string }, name: string): string => join(w.units, name, "secrets.yaml");
const read = (w: { units: string }, name: string): unknown => parse(readFileSync(unitFile(w, name), "utf8"));
const mode = (f: string): number => statSync(f).mode & 0o777;
const rejection = async (p: Promise<unknown>): Promise<string> => {
  let msg = "";
  await p.then(() => assert.fail("the projection should have failed"), (e: Error) => { msg = e.message; });
  return msg;
};

const OPERATOR = `llm:
  openai:
    api_key: "  sk-openai  "
    # a comment
  claude:
    api_key: ""
chat:
  twitch:
    client_id: cid
    client_secret: csecret
    access_token: tok
connections:
  discord:
    token: disc
tools:
  servers:
    weather:
      token: w-token
    files:
      token: f-token
    blank:
      token: "   "
`;

// @spec CFG-SEC-019, DEPLOY-SECRET-003
test("each unit gets a YAML mapping, nested as the operator's file is, holding exactly its declared paths that are set, trimmed, wildcard expanded, nothing else", async () => {
  const w = workspace(OPERATOR);
  await projectSecrets(w.root, [
    { composeName: "cortex", secrets: ["llm.openai.api_key", "llm.claude.api_key", "llm.bedrock.access_key_id"] },
    { composeName: "tools", secrets: ["tools.servers.*.token", "chat.twitch.client_id"] },
    { composeName: "connector-discord", secrets: ["connections.discord.token"] },
  ]);
  assert.deepEqual(read(w, "cortex"), { llm: { openai: { api_key: "sk-openai" } } }, "trimmed; a blank or unset declared path is absent");
  assert.deepEqual(read(w, "tools"), { tools: { servers: { weather: { token: "w-token" }, files: { token: "f-token" } } }, chat: { twitch: { client_id: "cid" } } }, "the wildcard matches every server that holds a token");
  assert.deepEqual(read(w, "connector-discord"), { connections: { discord: { token: "disc" } } });
  assert.doesNotMatch(readFileSync(unitFile(w, "cortex"), "utf8"), /#|comment/, "no comment is copied");
});

// @spec CFG-SEC-019, DEPLOY-SECRET-003
test("a unit with nothing set gets an empty mapping, and an absent operator file gives every unit an empty mapping", async () => {
  const w = workspace(OPERATOR);
  await projectSecrets(w.root, [{ composeName: "voice", secrets: ["voice.openai.api_key"] }]);
  assert.deepEqual(read(w, "voice"), {});
  const none = workspace(); // no secrets/secrets.yaml
  await projectSecrets(none.root, [{ composeName: "chat", secrets: ["chat.youtube.api_key"] }, { composeName: "ears", secrets: ["ears.http.token"] }]);
  assert.deepEqual(read(none, "chat"), {});
  assert.deepEqual(read(none, "ears"), {});
  assert.equal(existsSync(none.operator), false, "the projection never creates the operator's file");
});

// @spec DEPLOY-SECRET-003, DEPLOY-SECRET-005
test("a key outside SECRET_PATHS is projected into no unit, even one that lists it, and a cleared credential leaves the projection at the next run", async () => {
  const w = workspace("llm:\n  model: hijacked\n  openai:\n    api_key: sk-ok\nextra: 1\n");
  const unit = { composeName: "memory", secrets: ["llm.openai.api_key", "llm.model"] };
  await projectSecrets(w.root, [unit]);
  assert.deepEqual(read(w, "memory"), { llm: { openai: { api_key: "sk-ok" } } });
  writeFileSync(w.operator, "llm:\n  openai:\n    api_key: \"\"\n", { mode: 0o600 });
  await projectSecrets(w.root, [unit]);
  assert.deepEqual(read(w, "memory"), {});
});

// @spec DEPLOY-SECRET-003, DEPLOY-SECRET-010
test("secrets/units and each unit directory are created with mode 0700, each file is 0600 owned by the caller, and no temporary file is left", async () => {
  const w = workspace(OPERATOR);
  await projectSecrets(w.root, [{ composeName: "chat", secrets: ["chat.twitch.client_id"] }, { composeName: "mouth", secrets: [] }]);
  assert.equal(mode(w.units), 0o700);
  assert.equal(mode(join(w.units, "chat")), 0o700);
  assert.equal(mode(unitFile(w, "chat")), 0o600);
  assert.equal(statSync(unitFile(w, "chat")).uid, process.getuid!());
  assert.deepEqual(readdirSync(join(w.units, "chat")), ["secrets.yaml"], "the temporary file was renamed away");
  assert.equal(existsSync(join(w.units, "mouth")), false, "a unit that declares no secret path gets no directory");
  // a rerun replaces the file by rename: the inode changes, so a reader holding the old file never sees a partial write
  const before = statSync(unitFile(w, "chat")).ino;
  await projectSecrets(w.root, [{ composeName: "chat", secrets: ["chat.twitch.client_id"] }]);
  assert.notEqual(statSync(unitFile(w, "chat")).ino, before);
});

// @spec DEPLOY-SECRET-003
test("a directory under secrets/units that names no unit declaring a secret path is removed, and a unit that keeps its directory keeps nothing stale", async () => {
  const w = workspace(OPERATOR);
  await projectSecrets(w.root, [{ composeName: "chat", secrets: ["chat.twitch.client_id"] }, { composeName: "old-unit", secrets: ["connections.discord.token"] }]);
  assert.ok(existsSync(unitFile(w, "old-unit")));
  writeFileSync(join(w.units, "chat", "stray.txt"), "leftover");
  await projectSecrets(w.root, [{ composeName: "chat", secrets: ["chat.twitch.client_id"] }, { composeName: "mouth", secrets: [] }]);
  assert.equal(existsSync(join(w.units, "old-unit")), false, "dropped unit leaves no credential behind");
  assert.equal(existsSync(join(w.units, "mouth")), false);
  assert.ok(existsSync(unitFile(w, "chat")));
});

// @spec CFG-SEC-019, DEPLOY-SECRET-005
test("a file that cannot be read, is not YAML or whose root is not a mapping fails naming the file, with a syntax error reported by line and column only", async () => {
  const unreadable = workspace();
  mkdirSync(unreadable.operator); // reading a directory fails with EISDIR
  const m1 = await rejection(projectSecrets(unreadable.root, [{ composeName: "chat", secrets: ["chat.twitch.client_id"] }]));
  assert.ok(m1.includes(unreadable.operator) && /EISDIR/.test(m1), m1);

  const bad = workspace(`llm:\n  openai:\n    api_key: ${MARKER}\nbroken: [unclosed\n`);
  const m2 = await rejection(projectSecrets(bad.root, [{ composeName: "chat", secrets: ["llm.openai.api_key"] }]));
  assert.ok(m2.includes(bad.operator), m2);
  assert.match(m2, /line \d+, column \d+/);
  assert.ok(!m2.includes(MARKER), "no text of the file reaches the message");

  const list = workspace("- a\n- b\n");
  assert.ok((await rejection(projectSecrets(list.root, [{ composeName: "chat", secrets: [] }]))).includes(list.operator));
});

// @spec CFG-SEC-019, DEPLOY-SECRET-005
test("a non-string at a secret path, or a value that still holds a line break after trimming, fails naming the path and never the value", async () => {
  const num = workspace("chat:\n  youtube:\n    api_key: 12345678\n");
  const m1 = await rejection(projectSecrets(num.root, [{ composeName: "chat", secrets: ["chat.youtube.api_key"] }]));
  assert.ok(m1.includes("chat.youtube.api_key") && !m1.includes("12345678"), m1);
  const multi = workspace(`llm:\n  openai:\n    api_key: "${MARKER}\\nsecond"\n`);
  const m2 = await rejection(projectSecrets(multi.root, [{ composeName: "memory", secrets: ["llm.openai.api_key"] }]));
  assert.ok(m2.includes("llm.openai.api_key") && !/PROJECTION-MARKER|second/.test(m2), m2);
});

// @spec DEPLOY-SECRET-004, DEPLOY-SECRET-005
test("a failed projection leaves the unit files of the last good run in place", async () => {
  const w = workspace(OPERATOR);
  const units = [{ composeName: "chat", secrets: ["chat.twitch.client_id"] }];
  await projectSecrets(w.root, units);
  const good = readFileSync(unitFile(w, "chat"), "utf8");
  writeFileSync(w.operator, "chat: [unclosed\n", { mode: 0o600 });
  await rejection(projectSecrets(w.root, units));
  assert.equal(readFileSync(unitFile(w, "chat"), "utf8"), good);
});

// @spec CFG-SEC-019, DEPLOY-SECRET-007
test("secrets/secrets.yaml that is a symbolic link into ./config, ./data or ./secrets/units fails naming the link and writes no unit file", async () => {
  for (const sub of ["config", "data", join("secrets", "units")]) {
    const w = workspace();
    const dir = join(w.root, sub);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "real.yaml"), OPERATOR, { mode: 0o600 });
    symlinkSync(join(dir, "real.yaml"), w.operator);
    const msg = await rejection(projectSecrets(w.root, [{ composeName: "chat", secrets: ["chat.twitch.client_id"] }]));
    assert.ok(msg.includes(w.operator), `${sub}: ${msg}`);
    assert.equal(existsSync(unitFile(w, "chat")), false, `${sub}: no unit file`);
    assert.ok(!msg.includes("cid") && !msg.includes("csecret"));
  }
});

// @spec CFG-SEC-015, DEPLOY-SECRET-007
test("a link to a file outside those directories is followed and projected as usual", async () => {
  const w = workspace();
  const outside = mkdtempSync(join(tmpdir(), "cohost-outside-"));
  writeFileSync(join(outside, "real.yaml"), OPERATOR, { mode: 0o600 });
  symlinkSync(join(outside, "real.yaml"), w.operator);
  await projectSecrets(w.root, [{ composeName: "chat", secrets: ["chat.twitch.client_id"] }]);
  assert.deepEqual(read(w, "chat"), { chat: { twitch: { client_id: "cid" } } });
});

// @spec DEPLOY-SECRET-009
test("a missing secrets/units is created with mode 0700", async () => {
  const w = workspace(OPERATOR);
  assert.equal(existsSync(w.units), false);
  await projectSecrets(w.root, [{ composeName: "chat", secrets: ["chat.twitch.client_id"] }]);
  assert.equal(mode(w.units), 0o700);
});

// @spec DEPLOY-SECRET-009
test("secrets/, secrets/units or a unit directory that is a symbolic link fails naming that path and writes no unit file", async () => {
  const units = [{ composeName: "chat", secrets: ["chat.twitch.client_id"] }];
  // secrets/units is a link to a directory elsewhere
  const a = workspace(OPERATOR);
  const targetA = mkdtempSync(join(tmpdir(), "cohost-link-"));
  symlinkSync(targetA, a.units);
  assert.ok((await rejection(projectSecrets(a.root, units))).includes(a.units));
  assert.deepEqual(readdirSync(targetA), [], "nothing was written through the link");

  // a unit directory is a link
  const b = workspace(OPERATOR);
  mkdirSync(b.units, { mode: 0o700 });
  const targetB = mkdtempSync(join(tmpdir(), "cohost-link-"));
  symlinkSync(targetB, join(b.units, "chat"));
  assert.ok((await rejection(projectSecrets(b.root, units))).includes(join(b.units, "chat")));
  assert.deepEqual(readdirSync(targetB), [], "nothing was written through the link");
  assert.ok(lstatSync(join(b.units, "chat")).isSymbolicLink(), "the link is not replaced");

  // secrets/ itself is a link; the operator's file is reached through it
  const root = mkdtempSync(join(tmpdir(), "cohost-proj-"));
  const real = join(root, "elsewhere");
  mkdirSync(real, { mode: 0o700 });
  writeFileSync(join(real, "secrets.yaml"), OPERATOR, { mode: 0o600 });
  symlinkSync(real, join(root, "secrets"));
  process.env.COHOST_SECRETS_FILE = join(root, "secrets", "secrets.yaml");
  assert.ok((await rejection(projectSecrets(root, units))).includes(join(root, "secrets")));
  assert.equal(existsSync(join(real, "units")), false, "nothing was written through the link");
});

// @spec DEPLOY-SECRET-008, CFG-SEC-019
test("projecting an operator file that sets every path of SECRET_PATHS gives each unit exactly its declared paths", async () => {
  const set = (obj: Record<string, unknown>, path: string, v: string): void => {
    const keys = path.split(".");
    let o = obj;
    for (const k of keys.slice(0, -1)) o = (o[k] ??= {}) as Record<string, unknown>;
    o[keys.at(-1)!] = v;
  };
  const operator: Record<string, unknown> = {};
  for (const p of SECRET_PATHS) {
    if (p === "tools.servers.*.token") { set(operator, "tools.servers.a.token", "tok-a"); set(operator, "tools.servers.b.token", "tok-b"); } else set(operator, p, `v-${p}`);
  }
  const w = workspace(JSON.stringify(operator)); // JSON is YAML
  const flat = (o: unknown, prefix = ""): string[] => Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => (typeof v === "object" && v ? flat(v, `${prefix}${k}.`) : [`${prefix}${k}`]));
  const units = [
    { composeName: "u-one", secrets: SECRET_PATHS.filter((p) => p.startsWith("llm.")) },
    { composeName: "u-two", secrets: ["tools.servers.*.token", "chat.twitch.client_id"] },
    { composeName: "u-three", secrets: [...SECRET_PATHS] },
  ];
  await projectSecrets(w.root, units);
  const expand = (p: string): string[] => (p === "tools.servers.*.token" ? ["tools.servers.a.token", "tools.servers.b.token"] : [p]);
  for (const u of units) assert.deepEqual(flat(read(w, u.composeName)).sort(), u.secrets.flatMap(expand).sort(), u.composeName);
});

// @spec DEPLOY-SECRET-007
test("the operator's file is rejected when it resolves inside ./config, ./data or ./secrets/units, a regular file included", async () => {
  for (const sub of ["config", "data", join("secrets", "units")]) {
    const w = workspace();
    const dir = join(w.root, sub);
    mkdirSync(dir, { recursive: true });
    const inside = join(dir, "mine.yaml");
    writeFileSync(inside, OPERATOR, { mode: 0o600 });
    process.env.COHOST_SECRETS_FILE = inside; // a regular file, not a link
    const msg = await rejection(projectSecrets(w.root, [{ composeName: "chat", secrets: ["chat.twitch.client_id"] }]));
    assert.ok(msg.includes(inside), `${sub}: ${msg}`);
    assert.equal(existsSync(unitFile(w, "chat")), false, `${sub}: no unit file`);
  }
});

// @spec DEPLOY-SECRET-007
test("each of ./config, ./data and ./secrets/units is resolved first: a link to a directory the file lives in is rejected, a link elsewhere is not", async () => {
  for (const sub of ["config", "data"]) {
    const w = workspace();
    const real = mkdtempSync(join(tmpdir(), "cohost-real-"));
    writeFileSync(join(real, "mine.yaml"), OPERATOR, { mode: 0o600 });
    symlinkSync(real, join(w.root, sub)); // ./config (or ./data) is itself a link to the real directory
    symlinkSync(join(real, "mine.yaml"), w.operator); // the operator's file is a link into that real directory
    const msg = await rejection(projectSecrets(w.root, [{ composeName: "chat", secrets: ["chat.twitch.client_id"] }]));
    assert.ok(msg.includes(w.operator), `${sub}: ${msg}`);
    assert.equal(existsSync(unitFile(w, "chat")), false);
  }
  const w = workspace(OPERATOR);
  symlinkSync(mkdtempSync(join(tmpdir(), "cohost-real-")), join(w.root, "config"));
  await projectSecrets(w.root, [{ composeName: "chat", secrets: ["chat.twitch.client_id"] }]);
  assert.deepEqual(read(w, "chat"), { chat: { twitch: { client_id: "cid" } } });
});

// @spec DEPLOY-SECRET-009, CFG-SEC-019
test("a unit name that is not lower-case letters, digits and hyphens fails naming the name and writes nothing", async () => {
  for (const name of ["../../config", "a/b", "Chat", "", ".", "a b", "chat.yaml"]) {
    const w = workspace(OPERATOR);
    const msg = await rejection(projectSecrets(w.root, [{ composeName: "chat", secrets: ["chat.twitch.client_id"] }, { composeName: name, secrets: ["connections.discord.token"] }]));
    assert.ok(msg.includes(JSON.stringify(name)), `${JSON.stringify(name)}: ${msg}`);
    assert.equal(existsSync(unitFile(w, "chat")), false, "no unit file for any unit");
    assert.equal(existsSync(join(w.root, "config")), false, "nothing outside secrets/units");
  }
});
