import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PinnedLine, rowsFor, type TerminalIo } from "../src/pinned-line.js";

const ESC = "\x1b";
const LINE = "Unlock this browser: http://127.0.0.1:3000/unlock?n=AAAA";

/**
 * A terminal as `PinnedLine` sees it: what was written, its size (changed with `resize`), its one-shot timers (fired with
 * `fire`) and a process whose signal and exit listeners the test can emit and whose `kill` it records.
 */
function fakeTerminal(o: { tty?: boolean; rows?: number; cols?: number } = {}) {
  let size = { rows: o.rows ?? 24, cols: o.cols ?? 80 };
  const out: string[] = [];
  const resizers = new Set<() => void>();
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  const proc = Object.assign(new EventEmitter(), { killed: [] as string[], kill(sig: NodeJS.Signals) { this.killed.push(sig); } });
  const io: TerminalIo = {
    write: (s) => { out.push(s); },
    isTTY: () => o.tty ?? true,
    size: () => size,
    onResize: (fn) => { resizers.add(fn); return () => { resizers.delete(fn); }; },
    setTimer: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return () => { t.live = false; }; },
    proc,
  };
  return {
    io, out, proc, timers,
    /** Everything written since the last call. */
    take: (): string => out.splice(0).join(""),
    resize: (rows: number, cols = size.cols) => { size = { rows, cols }; for (const fn of [...resizers]) fn(); },
    /** Fires the live timers, as the clock reaching them would. */
    fire: () => { for (const t of timers.splice(0)) if (t.live) t.fn(); },
    liveTimers: () => timers.filter((t) => t.live),
    resizeListeners: () => resizers.size,
  };
}

// @spec DASH-UNL-009
test("the rows a line needs follow the terminal's width", () => {
  assert.equal(rowsFor("x".repeat(80), 80), 1);
  assert.equal(rowsFor("x".repeat(81), 80), 2);
  assert.equal(rowsFor("x".repeat(50), 20), 3);
  assert.equal(rowsFor("", 80), 1);
});

// @spec DASH-UNL-009
test("on a terminal with room the line is pinned: the scroll region is every row above it, the line is in the bottom rows and the cursor goes back into the region", () => {
  const t = fakeTerminal({ rows: 24, cols: 80 });
  const pin = new PinnedLine(t.io);
  pin.show(LINE, () => LINE, 600_000);
  const w = t.take();
  assert.ok(w.includes(`${ESC}[1;23r`), "the scroll region is rows 1 to 23");
  const at = w.indexOf(`${ESC}[24;1H`);
  assert.ok(at >= 0, "the line is written from row 24");
  assert.ok(w.indexOf(LINE) > at, "the line follows the move to its row");
  assert.ok(w.endsWith(`${ESC}8`), "the cursor is restored into the scroll region last");
  assert.equal(pin.pinned, true);
});

// @spec DASH-UNL-009
test("a line wider than the terminal takes as many bottom rows as it wraps to", () => {
  const line = "y".repeat(50);
  const t = fakeTerminal({ rows: 10, cols: 20 });
  new PinnedLine(t.io).show(line, () => line, 600_000);
  const w = t.take();
  assert.ok(w.includes(`${ESC}[1;7r`), "3 rows for the line, 7 for the logs");
  assert.ok(w.includes(`${ESC}[8;1H`));
});

// @spec DASH-UNL-009
test("pinning needs the line's rows plus 3: one row fewer writes the line once and pins nothing", () => {
  const line = "y".repeat(50); // 3 rows at width 20
  const enough = fakeTerminal({ rows: 6, cols: 20 });
  new PinnedLine(enough.io).show(line, () => line, 600_000);
  assert.ok(enough.take().includes(`${ESC}[1;3r`), "6 rows is 3 for the line and 3 for the logs");

  const short = fakeTerminal({ rows: 5, cols: 20 });
  const pin = new PinnedLine(short.io);
  pin.show(line, () => line, 600_000);
  assert.equal(short.take(), `${line}\n`);
  assert.equal(pin.pinned, false);
  assert.equal(short.liveTimers().length, 0, "nothing is renewed");
  assert.equal(short.resizeListeners(), 0);
});

// @spec DASH-UNL-009, DASH-UNL-001
test("when standard output is not a terminal the line is written once, plain, and nothing is pinned, renewed or hooked", () => {
  const t = fakeTerminal({ tty: false });
  const pin = new PinnedLine(t.io);
  let renewed = 0;
  pin.show(LINE, () => { renewed++; return LINE; }, 600_000);
  assert.equal(t.take(), `${LINE}\n`);
  assert.equal(pin.pinned, false);
  assert.equal(t.liveTimers().length, 0);
  assert.equal(t.resizeListeners(), 0);
  assert.equal(t.proc.listenerCount("exit"), 0);
  assert.equal(t.proc.listenerCount("SIGINT"), 0);
  t.fire();
  assert.equal(renewed, 0);
});

// @spec DASH-UNL-010
test("a resize sets the scroll region and writes the line again for the new size; too few rows resets the region until a resize leaves enough", () => {
  const t = fakeTerminal({ rows: 24, cols: 80 });
  const pin = new PinnedLine(t.io);
  pin.show(LINE, () => LINE, 600_000);
  t.take();

  t.resize(40);
  let w = t.take();
  assert.ok(w.includes(`${ESC}[1;39r`), "the region for 40 rows");
  assert.ok(w.indexOf(LINE) > w.indexOf(`${ESC}[40;1H`));

  t.resize(3);
  w = t.take();
  assert.ok(w.includes(`${ESC}[r`), "the region is the whole terminal again");
  assert.ok(!w.includes(LINE), "the line is not pinned in a terminal too small for it");
  assert.ok(!/\x1b\[1;\d+r/.test(w));

  t.resize(30);
  w = t.take();
  assert.ok(w.includes(`${ESC}[1;29r`), "pinned again once there is room");
  assert.ok(w.includes(LINE));
});

// @spec DASH-UNL-011
test("when the pinned nonce's 10 minutes end a fresh link is written in the pinned rows, and again 10 minutes later", () => {
  const t = fakeTerminal({ rows: 24, cols: 80 });
  const pin = new PinnedLine(t.io);
  let n = 0;
  const renew = () => `Unlock this browser: http://127.0.0.1:3000/unlock?n=FRESH${++n}`;
  pin.show(LINE, renew, 600_000);
  t.take();
  assert.deepEqual(t.liveTimers().map((x) => x.ms), [600_000]);
  t.fire();
  let w = t.take();
  assert.ok(w.indexOf("n=FRESH1") > w.indexOf(`${ESC}[24;1H`), "the new link in the pinned row");
  assert.ok(w.includes(`${ESC}[J`), "the old one cleared first");
  assert.ok(!w.includes(LINE));
  assert.deepEqual(t.liveTimers().map((x) => x.ms), [600_000], "the next renewal is set");
  t.fire();
  w = t.take();
  assert.ok(w.includes("n=FRESH2"));
  t.resize(30);
  assert.ok(t.take().includes("n=FRESH2"), "a resize repaints the current link");
});

// @spec DASH-UNL-012
test("release clears the pinned rows, resets the scroll region and stops renewing; later resizes write nothing", () => {
  const t = fakeTerminal({ rows: 24, cols: 80 });
  const pin = new PinnedLine(t.io);
  let renewed = 0;
  pin.show(LINE, () => { renewed++; return LINE; }, 600_000);
  t.take();
  pin.release();
  const w = t.take();
  assert.ok(w.includes(`${ESC}[r`), "the region is the whole terminal");
  assert.ok(w.indexOf(`${ESC}[J`) > w.indexOf(`${ESC}[24;1H`), "the pinned rows are cleared");
  assert.ok(!w.includes(LINE));
  assert.equal(pin.pinned, false);
  assert.equal(t.liveTimers().length, 0);
  t.fire();
  assert.equal(renewed, 0);
  t.resize(40);
  assert.equal(t.take(), "");
  pin.release();
  assert.equal(t.take(), "", "a second release writes nothing");
  assert.equal(t.proc.listenerCount("exit"), 0, "the exit hooks are gone");
  assert.equal(t.proc.listenerCount("SIGINT"), 0);
});

// @spec DASH-UNL-012
test("showing a new line while one is pinned replaces it", () => {
  const t = fakeTerminal({ rows: 24, cols: 80 });
  const pin = new PinnedLine(t.io);
  pin.show(LINE, () => LINE, 600_000);
  pin.show("second", () => "second", 600_000);
  t.take();
  assert.equal(t.liveTimers().length, 1, "one renewal");
  assert.equal(t.resizeListeners(), 1);
  assert.equal(t.proc.listenerCount("exit"), 1);
  t.resize(30);
  const w = t.take();
  assert.ok(w.includes("second") && !w.includes(LINE));
});

// @spec DASH-UNL-013
test("on exit the scroll region is reset and the pinned rows cleared", () => {
  const t = fakeTerminal({ rows: 24, cols: 80 });
  const pin = new PinnedLine(t.io);
  pin.show(LINE, () => LINE, 600_000);
  t.take();
  t.proc.emit("exit", 0);
  const w = t.take();
  assert.ok(w.includes(`${ESC}[r`));
  assert.ok(w.indexOf(`${ESC}[J`) > w.indexOf(`${ESC}[24;1H`));
  assert.equal(pin.pinned, false);
});

// @spec DASH-UNL-013
test("on SIGINT or SIGTERM the terminal is reset; with no other handler the signal is raised again so the process ends as it would have", () => {
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    const t = fakeTerminal({ rows: 24, cols: 80 });
    const pin = new PinnedLine(t.io);
    pin.show(LINE, () => LINE, 600_000);
    t.take();
    t.proc.emit(sig);
    assert.ok(t.take().includes(`${ESC}[r`), sig);
    assert.deepEqual(t.proc.killed, [sig], `${sig} raised again`);
    assert.equal(t.proc.listenerCount(sig), 0);
  }
});

// @spec DASH-UNL-013
test("when the process has its own SIGINT handler (the service shutdown), the terminal is reset and that handler alone decides the exit", () => {
  const t = fakeTerminal({ rows: 24, cols: 80 });
  let shutdowns = 0;
  t.proc.on("SIGINT", () => { shutdowns++; });
  const pin = new PinnedLine(t.io);
  pin.show(LINE, () => LINE, 600_000);
  t.take();
  t.proc.emit("SIGINT");
  assert.ok(t.take().includes(`${ESC}[r`));
  assert.equal(shutdowns, 1);
  assert.deepEqual(t.proc.killed, []);
});
