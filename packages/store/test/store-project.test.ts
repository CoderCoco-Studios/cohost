import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EARS_VERIFIER_PATH, OLLAMA_MODEL_SECTIONS, UNIT_SETTINGS, loadConfig, secretPathMatches } from "@cohost/config";
import {
  credentialsMessage, getsMessage, messageText, pocketToken, projectedUnits, projectionDir, projectionsDir, writeProjections, MODELS_PROJECTION,
} from "../src/index.js";
import { runCli } from "../src/cli/run.js";
import { fakeIo, sandbox } from "./helpers.js";

const TOKEN = "an-owner-chosen-control-token-long-enough";
const root = (): string => mkdtempSync(join(tmpdir(), "cohost-ws-"));
const read = (file: string): Record<string, unknown> => JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;

// @spec STORE-PROJ-001, STORE-PROJ-002, STORE-PROJ-005
test("each unit's projection holds exactly its declared sections and documents and no credential, written 0600 in a 0700 directory", async () => {
  const sb = sandbox();
  const s = await sb.open();
  s.write({ secrets: { "llm.openai.api_key": "sk-never-projected" } });
  s.setToken(TOKEN);
  const ws = root();
  writeProjections(s, ws);
  const written = readdirSync(projectionsDir(ws)).toSorted();
  assert.deepEqual(written, projectedUnits().map((u) => u.composeName).toSorted());
  assert.ok(written.includes("models"));
  for (const u of projectedUnits()) {
    const dir = projectionDir(ws, u.composeName);
    assert.equal(statSync(dir).mode & 0o777, 0o700, dir);
    const file = join(dir, "settings.json");
    assert.equal(statSync(file).mode & 0o777, 0o600, file);
    const text = readFileSync(file, "utf8");
    assert.doesNotMatch(text, /sk-never-projected/);
    assert.doesNotMatch(text, new RegExp(TOKEN));
    const p = read(file);
    assert.equal(p.format, 1);
    assert.equal(p.unit, u.id);
    assert.equal(p.revision, s.revision());
    assert.deepEqual(Object.keys(p.sections as object).toSorted(), [...u.config].toSorted(), `${u.id} holds exactly its sections`);
    assert.deepEqual(Object.keys(p.documents as object).toSorted(), [...u.documents].toSorted(), `${u.id} holds exactly its documents`);
    // The projection loads with the loader every service uses.
    assert.doesNotThrow(() => loadConfig({ dir, unit: u.id, force: true }), u.id);
  }
  assert.deepEqual(MODELS_PROJECTION.config, OLLAMA_MODEL_SECTIONS);
  assert.deepEqual(readdirSync(projectionDir(ws, "cortex")).toSorted(), ["settings.json"], "no temporary file is left");
  s.close();
});

// @spec STORE-PROJ-002
test("a projection directory that names no unit is removed; a symbolic link fails the write naming it", async () => {
  const sb = sandbox();
  const s = await sb.open();
  const ws = root();
  mkdirSync(join(projectionsDir(ws), "retired-unit"), { recursive: true });
  writeProjections(s, ws);
  assert.equal(existsSync(join(projectionsDir(ws), "retired-unit")), false);

  const other = root();
  mkdirSync(join(other, "data", "projections"), { recursive: true });
  symlinkSync(mkdtempSync(join(tmpdir(), "elsewhere-")), projectionDir(other, "chat"));
  assert.throws(() => writeProjections(s, other), /chat is a symbolic link/);
  assert.ok(lstatSync(projectionDir(other, "chat")).isSymbolicLink(), "nothing replaced the link");
  assert.throws(() => writeProjections(s, other, [{ id: "x", composeName: "../x", config: [], documents: [] }]), /not a unit name/);
  s.close();
});

// @spec STORE-PROJ-004
test("config:project writes every unit's projection and the models projection, and exits 1 with the reason when it cannot", async () => {
  const sb = sandbox();
  const ws = root();
  let io = fakeIo();
  assert.equal(await runCli(["project"], io, { ...sb.opts, workspaceRoot: ws }), 0, io.stderr);
  assert.ok(existsSync(join(projectionDir(ws, "models"), "settings.json")));
  assert.ok(existsSync(join(projectionDir(ws, "chat"), "settings.json")));
  const bad = root();
  mkdirSync(join(bad, "data"), { recursive: true });
  symlinkSync(mkdtempSync(join(tmpdir(), "elsewhere-")), join(bad, "data", "projections"));
  io = fakeIo();
  assert.equal(await runCli(["project"], io, { ...sb.opts, workspaceRoot: bad }), 1);
  assert.match(io.stderr, /projections were not written: .*symbolic link/);
});

// @spec STORE-DLV-002, STORE-DLV-008, STORE-STATE-001
test("a unit's message holds exactly the declared credentials the store holds, the listener key for ears alone, and a state key for a stateKey unit", async () => {
  const sb = sandbox();
  const s = await sb.open();
  const tools = (s.settingsTree().tools ?? {}) as Record<string, unknown>;
  s.write({ sections: { tools: { ...tools, servers: { docs: { url: "https://example.com/mcp" } } } } });
  const values: Record<string, string> = {
    "llm.openai.api_key": "v-llm", "chat.twitch.client_id": "v-tw-id", "chat.youtube.api_key": "v-yt", "voice.openai.api_key": "v-voice",
    "ears.openai.api_key": "v-ears", "connections.discord.token": "v-discord", "tools.servers.docs.token": "v-docs", "vision.obs.password": "v-obs",
    "voice.pocket.hf_token": "v-hf",
  };
  assert.ok(s.write({ secrets: values }).ok);
  s.setToken(TOKEN);
  for (const u of UNIT_SETTINGS) {
    const m = credentialsMessage(s, u.id);
    if (!getsMessage(u)) { assert.equal(m, undefined, `${u.id} gets no message`); continue; }
    assert.ok(m, u.id);
    assert.equal(m.format, 1);
    assert.equal(m.unit, u.id);
    const expected = Object.keys(values).filter((p) => u.secrets.some((d) => secretPathMatches(p, d)));
    if (u.id === "ears") expected.push(EARS_VERIFIER_PATH);
    assert.deepEqual(Object.keys(m.credentials).toSorted(), expected.toSorted(), `${u.id}: exactly the declared paths the store holds`);
    for (const p of expected) if (p !== EARS_VERIFIER_PATH) assert.equal(m.credentials[p], values[p]);
    const text = messageText(m);
    assert.doesNotMatch(text, new RegExp(TOKEN), "never the token");
    assert.doesNotMatch(text, new RegExp(s.recoveryKey().split(":")[1]!), "never the master key");
    assert.equal(m.state_key !== undefined, u.stateKey, `${u.id}: a state key exactly for a stateKey unit`);
    if (m.state_key) assert.equal(Buffer.from(m.state_key, "base64url").length, 32);
  }
  assert.match(credentialsMessage(s, "ears")!.credentials[EARS_VERIFIER_PATH]!, /^[0-9a-f]{64}$/);
  const chatKey = credentialsMessage(s, "chat")!.state_key;
  assert.equal(credentialsMessage(s, "chat")!.state_key, chatKey, "the state key is kept across deliveries");
  assert.notEqual(credentialsMessage(s, "avatar")!.state_key, chatKey, "each unit has its own");
  assert.equal(pocketToken(s), "v-hf");

  // A token of a server the tools section no longer holds is left out.
  s.write({ sections: { tools: { ...tools, servers: {} } } });
  assert.equal(credentialsMessage(s, "tools")!.credentials["tools.servers.docs.token"], undefined);
  s.close();
});

// @spec STORE-DLV-002, STORE-DLV-006
test("with no credential stored a messaged unit still gets a message with no credentials, and the Pocket token is empty", async () => {
  const sb = sandbox();
  const s = await sb.open();
  const m = credentialsMessage(s, "salience")!;
  assert.deepEqual(m.credentials, {});
  assert.equal(credentialsMessage(s, "ears")!.credentials[EARS_VERIFIER_PATH], undefined, "no listener key before a token is set");
  assert.equal(credentialsMessage(s, "mouth"), undefined);
  assert.equal(pocketToken(s), "");
  s.close();
});

// @spec STORE-TOK-001, DEPLOY-INST-013
test("config:token --if-unset sets a token only when the store holds no verifier", async () => {
  const sb = sandbox();
  let io = fakeIo();
  assert.equal(await runCli(["token", "--if-unset"], io, sb.opts), 0);
  assert.match(io.stdout, /The control token is:\n\n {2}\S{43}\n/);
  io = fakeIo();
  assert.equal(await runCli(["token", "--if-unset"], io, sb.opts), 0);
  assert.match(io.stdout, /already set; nothing was changed/);
  assert.doesNotMatch(io.stdout, /The control token is/);
});
