// Shared helpers of the native-transport facade tests (not a test file).
import assert from "node:assert/strict";
import { Bus, type BusOptions } from "../src/index.js";
export { FakeTransport, FakeReader, FakeFrameTransport, FakeFrameReader, rawEntry, groupRead, busError } from "../../testing/src/fake-transport.js";
import { FakeTransport, FakeFrameTransport } from "../../testing/src/fake-transport.js";

export const URL_UNUSED = "redis://127.0.0.1:1";

export function logger() {
  const lines: { level: string; obj: any; msg?: string }[] = [];
  const mk = (level: string) => (obj: any, msg?: string) => { lines.push({ level, obj, msg }); };
  const log = { warn: mk("warn"), error: mk("error"), info: mk("info"), debug: mk("debug"), fatal: mk("fatal"), trace: mk("trace") };
  return { log: log as never, lines, at: (level: string) => lines.filter((l) => l.level === level) };
}

export const tick = (ms = 20) => new Promise<void>((r) => setTimeout(r, ms));
export async function until(cond: () => boolean, what = "condition", ms = 1000): Promise<void> {
  const end = performance.now() + ms;
  while (!cond()) { if (performance.now() > end) assert.fail(`timed out waiting for: ${what}`); await tick(2); }
}
/** Fails instead of hanging when `p` does not settle. */
export const within = <T>(p: Promise<T>, ms = 1000, what = "promise"): Promise<T> => {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([p, new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new assert.AssertionError({ message: `${what} did not settle within ${ms} ms` })), ms); })]).finally(() => clearTimeout(timer));
};

/**
 * A Bus on a scripted events transport and a scripted frame transport. Asserts first that the facade took each from
 * `BusOptions.transport` / `BusOptions.frames` (BUS-NAT-API-004, BUS-NAT-FRM-007), so a facade that builds its own Redis
 * connection fails every test here at once, for that reason.
 */
export function busWith(fake: FakeTransport, opts: BusOptions = {}, url = URL_UNUSED, frames = new FakeFrameTransport()) {
  const l = logger();
  const bus = new Bus("t", l.log, url, { transport: fake.factory, frames: frames.factory, retryBaseMs: 5, retryMaxMs: 30, ...opts });
  if (fake.factoryCalls.length !== 1) {
    try { void bus.stop(); } catch { /* old facade */ }
    assert.fail("the Bus did not call BusOptions.transport to get its transport");
  }
  if (frames.factoryCalls.length !== 1) {
    try { void bus.stop(); } catch { /* old facade */ }
    assert.fail("the Bus did not call BusOptions.frames to get its frame transport");
  }
  return { bus, l, fake, frames };
}

/** Run `body` and always stop the bus (and swallow the loop promises it leaves). */
export async function withBus2(fake: FakeTransport, frames: FakeFrameTransport, opts: BusOptions, body: (b: ReturnType<typeof busWith>) => Promise<void>): Promise<void> {
  const b = busWith(fake, opts, URL_UNUSED, frames);
  try { await body(b); } finally { await Promise.race([b.bus.stop(), tick(1500)]); }
}
export const withBus = (fake: FakeTransport, opts: BusOptions, body: (b: ReturnType<typeof busWith>) => Promise<void>): Promise<void> =>
  withBus2(fake, new FakeFrameTransport(), opts, body);

/** Unhandled loop promise guard: start a loop and keep its outcome observable. */
export function run<T>(p: Promise<T>): { settled: boolean; error?: unknown; value?: T; done: Promise<void> } {
  const out: { settled: boolean; error?: unknown; value?: T; done: Promise<void> } = { settled: false, done: undefined as never };
  out.done = p.then((v) => { out.settled = true; out.value = v; }, (e) => { out.settled = true; out.error = e; });
  return out;
}
