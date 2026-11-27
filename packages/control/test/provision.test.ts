import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type StoreOptions } from "@cohost/store";
import {
  ComposeProvisioner, CREDENTIALS_SCRIPT, POCKET_SCRIPT, controlTokenRefusal, deliveriesFile, readDeliveries, storeSource, type ContainerStart, type DockerRun,
} from "../src/index.js";

const TOKEN = "an-owner-chosen-control-token-long-enough";
const quiet = { notice: { isTTY: false, write: () => {}, warn: () => {} }, warn: () => {} };

/** A sandboxed store holding a few credentials and a token, and a workspace root for the projections. */
async function world() {
  const base = mkdtempSync(join(tmpdir(), "cohost-prov-"));
  const opts: StoreOptions = { ...quiet, dataDir: join(base, "data-store"), keyFile: join(base, "key", "master.key") };
  const s = await openStore(opts);
  assert.ok(s.write({ secrets: { "llm.openai.api_key": "sk-llm-secret", "voice.pocket.hf_token": "hf-secret" } }).ok);
  s.setToken(TOKEN);
  s.close();
  const root = join(base, "ws");
  return { root, source: storeSource(root, opts), envFile: join(base, "no.env") };
}

/**
 * A docker stand-in: `compose ps -q` lists the containers of `state()`, `inspect` prints their start lines, `exec -i` records
 * the delivery with its input (failing for a container in `failExec`).
 */
function fakeDocker(state: () => ContainerStart[], failExec: Set<string> = new Set()) {
  const calls: { args: string[]; input?: string }[] = [];
  const docker: DockerRun = async (args, opts = {}) => {
    calls.push({ args, ...(opts.input !== undefined ? { input: opts.input } : {}) });
    if (args[0] === "compose" && args[1] === "ps") return { stdout: state().map((c) => c.id).join("\n"), stderr: "" };
    if (args[0] === "inspect") {
      const ids = args.slice(3);
      return { stdout: state().filter((c) => ids.includes(c.id)).map((c) => `${c.id} /${c.name} ${c.service} ${c.startedAt} ${c.running}`).join("\n"), stderr: "" };
    }
    if (args[0] === "exec" && failExec.has(args[2]!)) throw Object.assign(new Error("exit 126"), { code: 126 });
    return { stdout: "", stderr: "" };
  };
  return { docker, calls, deliveries: () => calls.filter((c) => c.args[0] === "exec") };
}

const box = (id: string, service: string, startedAt: string, running = true): ContainerStart =>
  ({ id: id.padEnd(12, "0"), name: `cohost-${service}-1`, service, startedAt, running });

// @spec STORE-TOK-005
test("CONTROL_TOKEN in .env or the environment is refused, naming the line or the environment and never the value", () => {
  const dir = mkdtempSync(join(tmpdir(), "cohost-env-"));
  const env = join(dir, ".env");
  writeFileSync(env, "DASHBOARD_HOST=127.0.0.1\n# CONTROL_TOKEN=commented\nCONTROL_TOKEN=\n");
  assert.equal(controlTokenRefusal({}, env), undefined, "an empty or commented line is no token");
  writeFileSync(env, `DASHBOARD_HOST=127.0.0.1\nCONTROL_TOKEN="${TOKEN}"\n`);
  const r = controlTokenRefusal({}, env)!;
  assert.match(r, /\.env defines CONTROL_TOKEN on line 2: remove that line/);
  assert.match(r, /password manager/);
  assert.match(r, /mise run config:token -- --stdin/);
  assert.doesNotMatch(r, new RegExp(TOKEN));
  const e = controlTokenRefusal({ CONTROL_TOKEN: ` ${TOKEN} ` }, join(dir, "none"))!;
  assert.match(e, /the environment defines CONTROL_TOKEN/);
  assert.doesNotMatch(e, new RegExp(TOKEN));
  assert.equal(controlTokenRefusal({ CONTROL_TOKEN: "  " }, join(dir, "none")), undefined);
});

// @spec STORE-PROJ-003, CTRL-RUNTIME-014, STORE-TOK-005
test("before refuses a token before writing anything, and otherwise writes every unit's projection", async () => {
  const w = await world();
  const d = fakeDocker(() => []);
  const refused = await new ComposeProvisioner({ root: w.root, docker: d.docker, env: { CONTROL_TOKEN: TOKEN }, envFile: w.envFile, source: w.source }).before();
  assert.equal(refused.ok, false);
  assert.equal(existsSync(join(w.root, "data", "projections")), false, "nothing written");
  assert.equal(d.calls.length, 0, "no docker command");
  const ok = await new ComposeProvisioner({ root: w.root, docker: d.docker, env: {}, envFile: w.envFile, source: w.source }).before();
  assert.equal(ok.ok, true);
  const cortex = readFileSync(join(w.root, "data", "projections", "cortex", "settings.json"), "utf8");
  assert.doesNotMatch(cortex, /sk-llm-secret/);
  assert.ok(existsSync(join(w.root, "data", "projections", "models", "settings.json")));
  w.source.close();
});

// @spec STORE-PROJ-003
test("a projection that cannot be written fails before, naming the reason", async () => {
  const w = await world();
  const blocked = mkdtempSync(join(tmpdir(), "cohost-blocked-"));
  writeFileSync(join(blocked, "data"), "a file where the data directory belongs");
  const r = await new ComposeProvisioner({ root: blocked, docker: fakeDocker(() => []).docker, env: {}, envFile: w.envFile, source: storeSource(blocked, { ...quiet, dataDir: join(w.root, "..", "data-store"), keyFile: join(w.root, "..", "key", "master.key") }) }).before();
  assert.equal(r.ok, false);
  assert.match((r as { detail: string }).detail, /^the projections could not be written: /);
  w.source.close();
});

// @spec STORE-DLV-001, STORE-DLV-003, STORE-DLV-006, CTRL-RUNTIME-018, STORE-DLV-008
test("after delivers to every container the command started (new or a changed StartedAt) through docker exec -i, never to an untouched one, and records it", async () => {
  const w = await world();
  let state = [box("a1", "cortex", "t1"), box("b1", "voice", "t1"), box("c1", "mouth", "t1")];
  const d = fakeDocker(() => state);
  const p = new ComposeProvisioner({ root: w.root, docker: d.docker, env: {}, envFile: w.envFile, source: w.source });
  const before = await p.before();
  assert.ok(before.ok);
  // cortex restarted, voice untouched, salience and tts-pocket new, mouth restarted (it gets no message).
  state = [box("a1", "cortex", "t2"), box("b1", "voice", "t1"), box("c1", "mouth", "t2"), box("d1", "salience", "t2"), box("e1", "tts-pocket", "t2")];
  assert.deepEqual(await before.after(), { ok: true });
  const delivered = d.deliveries();
  assert.deepEqual(delivered.map((c) => c.args.slice(0, 5)).toSorted(), [
    ["exec", "-i", "a10000000000", "sh", "-c"], ["exec", "-i", "d10000000000", "sh", "-c"], ["exec", "-i", "e10000000000", "sh", "-c"],
  ].toSorted());
  const byId = (id: string) => delivered.find((c) => c.args[2] === id.padEnd(12, "0"))!;
  assert.equal(byId("a1").args[5], CREDENTIALS_SCRIPT);
  assert.equal(CREDENTIALS_SCRIPT, "umask 077 && cat > /run/cohost/.credentials.json.tmp && mv /run/cohost/.credentials.json.tmp /run/cohost/credentials.json");
  const message = JSON.parse(byId("a1").input!) as { unit: string; credentials: Record<string, string> };
  assert.equal(message.unit, "cortex");
  assert.deepEqual(message.credentials, { "llm.openai.api_key": "sk-llm-secret" });
  assert.equal(byId("e1").args[5], POCKET_SCRIPT);
  assert.equal(byId("e1").input, "hf-secret");
  for (const c of d.calls) assert.ok(!c.args.some((a) => /sk-llm-secret|hf-secret/.test(a)), "a credential is never an argument");
  const records = readDeliveries(w.root);
  assert.deepEqual(records.cortex, { unit: "cortex", container: "a10000000000", startedAt: "t2" });
  assert.deepEqual(records["tts-pocket"], { unit: "tts-pocket", container: "e10000000000", startedAt: "t2" });
  assert.equal(records.voice, undefined);
  assert.equal(statSync(deliveriesFile(w.root)).mode & 0o777, 0o600);
  assert.doesNotMatch(readFileSync(deliveriesFile(w.root), "utf8"), /secret/);
  w.source.close();
});

// @spec STORE-DLV-003, CTRL-RUNTIME-010
test("after delivers the memory unit's message to a one-shot named by --name, and a failed exec names the unit and status, never the message", async () => {
  const w = await world();
  let state: ContainerStart[] = [];
  const d = fakeDocker(() => state, new Set(["d20000000000"]));
  const p = new ComposeProvisioner({ root: w.root, docker: d.docker, env: {}, envFile: w.envFile, source: w.source });
  const before = await p.before();
  assert.ok(before.ok);
  assert.deepEqual(await before.after({ name: "cohost-consolidate-x", unit: "memory" }), { ok: true });
  const one = d.deliveries()[0]!;
  assert.equal(one.args[2], "cohost-consolidate-x");
  assert.equal((JSON.parse(one.input!) as { unit: string }).unit, "memory");

  const again = await p.before();
  assert.ok(again.ok);
  state = [box("d2", "salience", "t9")];
  const r = await again.after();
  assert.equal(r.ok, false);
  assert.match(r.detail!, /the credentials of salience could not be delivered \(docker exec exited 126\)/);
  assert.doesNotMatch(r.detail!, /sk-llm-secret/);
  w.source.close();
});

// @spec STORE-DLV-005, CTRL-CLI-019
test("redeliver: a waiting unit and a unit whose StartedAt differs from its record get a delivery; a ready unit with no record is skipped", async () => {
  const w = await world();
  const state = [box("a3", "cortex", "t1"), box("b3", "voice", "t5"), box("c3", "salience", "t1"), box("e3", "tts-pocket", "t1"), box("f3", "mouth", "t1")];
  const d = fakeDocker(() => state);
  const p = new ComposeProvisioner({ root: w.root, docker: d.docker, env: {}, envFile: w.envFile, source: w.source });
  // voice was delivered at t4 and restarted by Docker since; salience is ready with no record; cortex waits.
  const before = readDeliveries(w.root);
  assert.deepEqual(before, {});
  const seeded = { voice: { unit: "voice", container: "b30000000000", startedAt: "t4" } };
  mkdirSync(join(w.root, "data", "control"), { recursive: true });
  writeFileSync(deliveriesFile(w.root), JSON.stringify(seeded));
  const r = await p.redeliver({ waiting: new Set(["cortex"]), ready: new Set(["salience", "voice"]) });
  assert.deepEqual(r.failures, []);
  assert.deepEqual(r.delivered.toSorted(), ["cortex", "tts-pocket", "voice"]);
  assert.equal(readDeliveries(w.root).voice!.startedAt, "t5");
  const second = await p.redeliver({ waiting: new Set(), ready: new Set(["salience", "voice", "cortex"]) });
  assert.deepEqual(second.delivered, [], "at most once per container start");
  w.source.close();
});

// @spec STORE-DLV-003
test("after delivers to a container Docker restarted since its recorded delivery, though the command itself did not start it", async () => {
  const w = await world();
  let state = [box("aaa", "cortex", "t1")];
  const d = fakeDocker(() => state);
  const p = new ComposeProvisioner({ root: w.root, docker: d.docker, env: {}, envFile: w.envFile, source: w.source });
  const first = await p.before();
  assert.ok(first.ok);
  state = [box("aaa", "cortex", "t2")];
  assert.ok((await first.after()).ok);
  assert.equal(d.deliveries().length, 1, "started by the command: delivered");
  // Docker restarts it by its policy: a later command that leaves it untouched still delivers, because the record is stale.
  state = [box("aaa", "cortex", "t3")];
  const second = await p.before();
  assert.ok(second.ok);
  assert.ok((await second.after()).ok);
  assert.equal(d.deliveries().length, 2, "StartedAt differs from the record: delivered again");
  const third = await p.before();
  assert.ok(third.ok);
  assert.ok((await third.after()).ok);
  assert.equal(d.deliveries().length, 2, "record current and not started: nothing delivered");
  assert.equal(readDeliveries(w.root).cortex?.startedAt, "t3");
  w.source.close();
});

// @spec STORE-DLV-003
test("before fails, delivering nothing, when the project's containers cannot be listed", async () => {
  const w = await world();
  const docker: DockerRun = async (args) => {
    if (args[0] === "compose" && args[1] === "ps") throw new Error("Cannot connect to the Docker daemon");
    return { stdout: "", stderr: "" };
  };
  const r = await new ComposeProvisioner({ root: w.root, docker, env: {}, envFile: w.envFile, source: w.source }).before();
  assert.equal(r.ok, false);
  assert.match((r as { detail: string }).detail, /docker compose ps failed: Cannot connect to the Docker daemon/);
  w.source.close();
});
