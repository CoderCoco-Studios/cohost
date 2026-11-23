// Tests of the docs site's example driver, examples/avatar-driver/udp-json.ts (AVATAR-EX-*). The example is outside this
// project's rootDir, so it is loaded at run time; `tsc -p examples/tsconfig.json` checks it against AvatarDriver.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { NEUTRAL, type AvatarDriver, type DriverContext } from "../src/types.js";

const file = fileURLToPath(new URL("../../../examples/avatar-driver/udp-json.ts", import.meta.url));
const { UdpJsonDriver } = (await import(pathToFileURL(file).href)) as {
  UdpJsonDriver: new (o: { host: string; port: number }) => AvatarDriver;
};

const warnings: unknown[][] = [];
const log = { warn: (...a: unknown[]) => warnings.push(a), info() {}, error() {}, debug() {} } as never;
const ctx = (over: Partial<DriverContext> = {}): DriverContext => ({
  log, stateDir: "/tmp", expressions: { happy: "Smile", sad: "" }, gestures: { wave: "WAVE" }, frames: { publishAvatarFrame: async () => {} }, ...over,
});

/** A UDP listener on an ephemeral loopback port that keeps the JSON each datagram holds. */
async function listener() {
  const sock = dgram.createSocket("udp4");
  const got: Record<string, unknown>[] = [];
  sock.on("message", (m) => got.push(JSON.parse(m.toString("utf8")) as Record<string, unknown>));
  await new Promise<void>((r) => sock.bind(0, "127.0.0.1", r));
  const port = sock.address().port;
  const waitFor = async (n: number) => {
    const t0 = performance.now();
    while (got.length < n) {
      if (performance.now() - t0 > 2000) throw new Error(`timed out waiting for ${n} datagrams, have ${got.length}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  return { port, got, waitFor, close: () => sock.close() };
}

test("the example imports only node: built-ins as values and the avatar types type-only", () => { // @spec AVATAR-EX-001
  const src = readFileSync(file, "utf8");
  const imports = [...src.matchAll(/^import\s+(type\s+)?[^;]*?from\s+"([^"]+)"/gm)];
  assert.ok(imports.length > 0);
  for (const [, typeOnly, from] of imports) {
    if (typeOnly) continue;
    assert.ok(from!.startsWith("node:"), `value import of ${from}`);
  }
  assert.ok(imports.some(([, t, from]) => t && from!.endsWith("services/avatar/src/types.ts")), "types come from the avatar service");
});

test("the driver is named udp-json and is constructed with { host, port }", () => { // @spec AVATAR-EX-001
  const d = new UdpJsonDriver({ host: "127.0.0.1", port: 1 });
  assert.equal(d.name, "udp-json");
  assert.equal(d.connected(), false);
});

test("one JSON datagram per call, with names mapped through ctx and an unmapped or empty name passed through", async () => { // @spec AVATAR-EX-002
  const l = await listener();
  const d = new UdpJsonDriver({ host: "127.0.0.1", port: l.port });
  await d.connect(ctx());
  assert.equal(d.connected(), true);
  d.setParams({ ...NEUTRAL, mouthOpen: 0.5, headX: -3 });
  d.setExpression("happy", 0.75);
  d.setExpression("sad", 0.25); // mapped to "", so the canonical name goes out
  d.setExpression("think", 1); // not in the map
  d.trigger("wave");
  d.trigger("nod");
  await l.waitFor(6);
  const byKind = (t: string) => l.got.filter((m) => m.type === t);
  assert.deepEqual(byKind("params"), [{ type: "params", ...NEUTRAL, mouthOpen: 0.5, headX: -3 }]);
  assert.deepEqual(byKind("expression"), [
    { type: "expression", name: "Smile", intensity: 0.75 },
    { type: "expression", name: "sad", intensity: 0.25 },
    { type: "expression", name: "think", intensity: 1 },
  ]);
  assert.deepEqual(byKind("gesture"), [{ type: "gesture", name: "WAVE" }, { type: "gesture", name: "nod" }]);
  await d.disconnect();
  l.close();
});

test("before connect and after disconnect it reports not connected and sends nothing; a later connect connects again", async () => { // @spec AVATAR-EX-003, AVATAR-EX-002
  const l = await listener();
  const d = new UdpJsonDriver({ host: "127.0.0.1", port: l.port });
  d.setParams(NEUTRAL); d.setExpression("happy", 1); d.trigger("wave");
  await d.connect(ctx());
  await d.disconnect();
  assert.equal(d.connected(), false);
  d.setParams(NEUTRAL); d.setExpression("happy", 1); d.trigger("wave");
  await d.connect(ctx());
  assert.equal(d.connected(), true);
  d.trigger("wave");
  await l.waitFor(1);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(l.got, [{ type: "gesture", name: "WAVE" }], "only the call made while connected arrived");
  await d.disconnect();
  l.close();
});

test("a send that throws or reports an error is logged at warn and never reaches the caller", async () => { // @spec AVATAR-EX-004
  const d = new UdpJsonDriver({ host: "127.0.0.1", port: 9 });
  await d.connect(ctx());
  for (const mode of ["throw", "callback"] as const) {
    warnings.length = 0;
    const send = mock.method(dgram.Socket.prototype, "send", (...args: unknown[]) => {
      if (mode === "throw") throw new Error("boom");
      const cb = args.find((a) => typeof a === "function") as ((e: Error) => void) | undefined;
      cb?.(new Error("unreachable"));
    });
    assert.doesNotThrow(() => { d.setParams(NEUTRAL); d.setExpression("happy", 1); d.trigger("wave"); }, mode);
    send.mock.restore();
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(warnings.length >= 1, `${mode}: warned`);
  }
  await d.disconnect();
});
