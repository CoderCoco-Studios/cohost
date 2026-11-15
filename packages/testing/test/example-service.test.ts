// Tests of the docs site's example service, examples/service/now-playing.ts (MOD-EX-*). It runs on a FakeBus and the
// bootstrap's test seams, as the services' own tests do; no Redis, no signals, no exit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { EventType, Handler, SubscribeOptions } from "@cohost/bus";
import { event, FakeBus, recordingLog, testConfig, waitFor } from "../src/index.js";

const file = fileURLToPath(new URL("../../../examples/service/now-playing.ts", import.meta.url));
const example = (await import(pathToFileURL(file).href)) as {
  runNowPlaying(opts: { file: string; pollMs?: number }, env?: Record<string, unknown>): Promise<void>;
};

/** A FakeBus that records the consumer-group calls the service makes and keeps its `brain.say` handler. */
class GroupBus extends FakeBus {
  calls: string[] = [];
  subscribed: SubscribeOptions<EventType>[] = [];
  handler?: Handler<EventType>;
  stopped = false;
  gate?: Promise<void>;
  async resetGroup(group: string): Promise<void> { this.calls.push(`resetGroup:${group}`); await this.gate; }
  async subscribe<T extends EventType>(opts: SubscribeOptions<T>, handler: Handler<T>): Promise<void> {
    this.calls.push(`subscribe:${opts.group}`);
    this.subscribed.push(opts as SubscribeOptions<EventType>);
    this.handler = handler as unknown as Handler<EventType>;
  }
  stop(): void { this.stopped = true; }
}

const dir = mkdtempSync(join(tmpdir(), "now-playing-"));
const watched = join(dir, "song.txt");
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

async function start(opts: { gate?: boolean; path?: string } = {}) {
  const bus = new GroupBus();
  let open: () => void = () => {};
  if (opts.gate) bus.gate = new Promise<void>((r) => (open = r));
  const shutdown: (() => void | Promise<void>)[] = [];
  const { log, lines } = recordingLog();
  const started = example.runNowPlaying({ file: opts.path ?? watched, pollMs: 15 }, {
    loadConfig: () => testConfig(),
    createBus: () => bus,
    onShutdown: (fn: () => void | Promise<void>) => { shutdown.push(fn); },
    exit: () => {},
    log,
  });
  const stop = async () => { for (const fn of shutdown) await fn(); await started; };
  return { bus, open, started, stop, lines };
}
const summaries = (bus: GroupBus) => bus.of("vision.summary");
const states = (bus: GroupBus) => bus.health.map((h) => h.state);

test("run with no argument it prints a usage line on standard error and exits 1", () => { // @spec MOD-EX-001
  const r = spawnSync(process.execPath, ["--import", "tsx", file], { encoding: "utf8", timeout: 20_000 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /usage/i);
});

test("a first non-empty title and each change publish vision.summary; empty, unchanged and missing files publish nothing", async () => { // @spec MOD-EX-002, MOD-EX-001
  rmSync(watched, { force: true });
  const { bus, stop } = await start();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(summaries(bus).length, 0, "no file, nothing published");
  writeFileSync(watched, "\n");
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(summaries(bus).length, 0, "an empty title publishes nothing");
  writeFileSync(watched, "Song A\n");
  await waitFor(() => summaries(bus).length === 1, "first title");
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(summaries(bus).length, 1, "unchanged title publishes once");
  writeFileSync(watched, "Song B");
  await waitFor(() => summaries(bus).length === 2, "changed title");
  assert.deepEqual(summaries(bus).map((s) => [s.text, s.changed]), [["Now playing: Song A", true], ["Now playing: Song B", true]]);
  await stop();
});

test("the group is positioned at the latest entry and subscribed to brain.say; a line naming the song is logged", async () => { // @spec MOD-EX-003
  writeFileSync(watched, "Blue Monday");
  const { bus, stop, lines } = await start();
  await waitFor(() => bus.calls.includes("subscribe:now-playing"), "subscription");
  assert.deepEqual(bus.calls, ["resetGroup:now-playing", "subscribe:now-playing"]);
  assert.deepEqual(bus.subscribed[0], { group: "now-playing", types: ["brain.say"], start: "latest" });
  await waitFor(() => summaries(bus).length === 1, "title");
  await bus.handler!(event("brain.say", { id: "1", text: "I love this BLUE monday remix", emotion: "happy" }));
  await bus.handler!(event("brain.say", { id: "2", text: "something else", emotion: "neutral" }));
  const mentions = lines.filter((l) => l.level === "info" && l.msg === "co-host mentioned the song");
  assert.equal(mentions.length, 1);
  assert.deepEqual(mentions[0]!.obj, { text: "I love this BLUE monday remix" });
  await stop();
});

test("before a title is published no brain.say line counts as a mention", async () => { // @spec MOD-EX-003
  rmSync(watched, { force: true });
  const { bus, stop, lines } = await start();
  await waitFor(() => bus.handler !== undefined, "subscription");
  await bus.handler!(event("brain.say", { id: "1", text: "anything", emotion: "neutral" }));
  assert.equal(lines.filter((l) => l.msg === "co-host mentioned the song").length, 0);
  await stop();
});

test("the heartbeat is live with file down until a read succeeds, ok while reads succeed, down when they fail, and ready follows the group", async () => { // @spec MOD-EX-004
  rmSync(watched, { force: true });
  const { bus, open, stop } = await start({ gate: true });
  await waitFor(() => states(bus).includes("starting"), "starting heartbeat");
  await new Promise((r) => setTimeout(r, 40));
  assert.ok(!states(bus).includes("ready"), "not ready while the group is being created");
  open();
  await waitFor(() => states(bus).includes("ready") || states(bus).includes("degraded"), "ready");
  const last = () => bus.health.at(-1)!;
  assert.equal(last().mode, "live");
  await waitFor(() => last().deps.file === "down", "file down");
  writeFileSync(watched, "x");
  await waitFor(() => last().deps.file === "ok", "file ok");
  rmSync(watched);
  await waitFor(() => last().deps.file === "down", "file down again");
  await stop();
});

test("once stopped it polls no more and publishes no vision.summary", async () => { // @spec MOD-EX-005
  writeFileSync(watched, "First");
  const { bus, stop } = await start();
  await waitFor(() => summaries(bus).length === 1, "first title");
  await stop();
  writeFileSync(watched, "Second");
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(summaries(bus).length, 1);
});
