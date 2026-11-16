import { test } from "node:test";
import assert from "node:assert/strict";
import { render, screen, userEvent, within } from "./helpers/render";
import { Status, serviceStatus, stackStatus, type StatusKind } from "../../ui/src/components/Status";
import { Meter, strengthWord } from "../../ui/src/components/Meter";
import { Banner } from "../../ui/src/components/Banner";
import { ActionStatus } from "../../ui/src/components/ActionStatus";
import { EmptyState, ErrorState, LoadingState } from "../../ui/src/components/StateBlocks";
import { Icon } from "../../ui/src/components/Icon";

// @spec DASH-THEME-004
test("each of the five statuses is an SVG shape that differs per status, the word as text, and a status class", () => {
  const kinds: StatusKind[] = ["ok", "warn", "bad", "building", "stopped"];
  const shapes = new Set<string>();
  for (const k of kinds) {
    const { container, unmount } = render(<Status status={k} label={`word-${k}`} />);
    const el = container.firstElementChild as HTMLElement;
    assert.match(el.className, new RegExp(`\\bst-${k}\\b`));
    assert.equal(el.textContent, `word-${k}`);
    const svg = el.querySelector("svg")!;
    assert.equal(svg.getAttribute("aria-hidden"), "true");
    shapes.add(svg.innerHTML);
    unmount();
  }
  assert.equal(shapes.size, 5, "every status has its own shape");
});

// @spec DASH-THEME-004
test("the statuses use the shapes the design names: filled circle, triangle, cross, open ring, dashed ring", () => {
  const html = (k: StatusKind) => render(<Status status={k} label="x" />).container.querySelector("svg")!.innerHTML;
  assert.match(html("ok"), /<circle[^>]*fill="currentColor"/);
  assert.match(html("warn"), /<path[^>]*d="M[^"]*"[^>]*fill="currentColor"/);
  assert.match(html("bad"), /<path[^>]*stroke="currentColor"/);
  assert.match(html("building"), /<circle[^>]*stroke-dasharray/);
  assert.match(html("stopped"), /<circle[^>]*stroke-dasharray="2 2"/);
});

// @spec DASH-THEME-004
test("service states map to the design's table: Up ok, Degraded and Stale warn, Down and Crash-looping bad, Unknown stopped, a starting unit building", () => {
  const s = (state: string, hbState?: string) => serviceStatus({ service: "x", state, restarts: 0, ...(hbState ? { heartbeat: { service: "x", state: hbState, deps: {} } } : {}) } as never);
  assert.deepEqual(s("up"), { status: "ok", word: "Up" });
  assert.deepEqual(s("degraded"), { status: "warn", word: "Degraded" });
  assert.deepEqual(s("degraded", "starting"), { status: "building", word: "Starting" });
  assert.deepEqual(s("stale"), { status: "warn", word: "Stale" });
  assert.deepEqual(s("down"), { status: "bad", word: "Down" });
  assert.deepEqual(s("crash-looping"), { status: "bad", word: "Crash-looping" });
  assert.deepEqual(s("unknown"), { status: "stopped", word: "Unknown" });
});

// @spec DASH-THEME-004
test("stack states map to the design's table", () => {
  assert.deepEqual(stackStatus("up"), { status: "ok", word: "Up" });
  assert.deepEqual(stackStatus("degraded"), { status: "warn", word: "Degraded" });
  assert.deepEqual(stackStatus("docker-unavailable"), { status: "bad", word: "Docker unavailable" });
  assert.deepEqual(stackStatus("starting"), { status: "building", word: "Starting" });
  assert.deepEqual(stackStatus("stopping"), { status: "building", word: "Stopping" });
  assert.deepEqual(stackStatus("down"), { status: "stopped", word: "Down" });
});

test("strengthWord follows the design: Strong at 70% or more, Fading from 30% up to 70%, Weak below 30%", () => {
  assert.deepEqual([100, 70, 69.9, 30, 29.9, 0].map(strengthWord), ["Strong", "Strong", "Fading", "Fading", "Weak", "Weak"]);
});

// @spec DASH-VIEWERS-011
test("Meter is a native <meter> with an accessible name carrying the word and the percent, and the same text beside it", () => {
  render(<Meter label="Note strength" percent={90} word="Strong" />);
  const m = screen.getByRole("meter", { name: "Note strength: Strong 90%" }) as HTMLMeterElement;
  // happy-dom does not implement <meter>'s value and max getters (they read 1); the attributes are what a browser reads.
  assert.equal(m.getAttribute("value"), "90");
  assert.equal(m.getAttribute("max"), "100");
  assert.ok(screen.getByText("Strong · 90%"));
});

test("Banner is a note in a tone; a bad banner is an alert and the others a status region", () => {
  render(<><Banner tone="bad" title="Down">It broke</Banner><Banner tone="warn">Careful</Banner></>);
  assert.equal(screen.getByRole("alert").textContent, "DownIt broke");
  assert.ok(screen.getByRole("status"));
  assert.match(screen.getByRole("alert").className, /note-bad/);
});

// @spec DASH-UI-015, DASH-A11Y-004
test("ActionStatus announces success in an <output> and a failure in a role=alert with the status and detail, dismissable", async () => {
  const user = userEvent.setup();
  let dismissed = 0;
  const { rerender } = render(<ActionStatus state={{ kind: "ok", message: "Muted" }} onDismiss={() => dismissed++} />);
  assert.equal(document.querySelector("output")!.textContent, "Muted");
  assert.ok(screen.queryByRole("alert") === null, "expected nothing to be found");
  rerender(<ActionStatus state={{ kind: "error", message: "409 busy: launch held", status: 409, locked: false }} onDismiss={() => dismissed++} />);
  assert.equal(within(screen.getByRole("alert")).getByText("409 busy: launch held").textContent, "409 busy: launch held");
  assert.equal(document.querySelector("output")!.textContent, "", "no success text while failed");
  await user.click(screen.getByRole("button", { name: "Dismiss" }));
  assert.equal(dismissed, 1);
});

// @spec DASH-UI-015
test("ActionStatus shows nothing while idle or pending, but keeps the live region mounted so a later message is announced", () => {
  const { rerender } = render(<ActionStatus state={{ kind: "idle" }} />);
  assert.equal(document.querySelector("output")!.textContent, "");
  rerender(<ActionStatus state={{ kind: "pending" }} />);
  assert.equal(document.querySelector("output")!.textContent, "");
  assert.ok(screen.queryByRole("alert") === null, "expected nothing to be found");
});

test("state blocks: empty, loading (aria-busy status) and error (alert with Retry)", async () => {
  const user = userEvent.setup();
  let retried = 0;
  render(<><EmptyState title="No services reported yet">Start something.</EmptyState><LoadingState label="Loading viewers…" /><ErrorState message="Could not load: 500 boom" onRetry={() => retried++} /></>);
  assert.ok(screen.getByText("No services reported yet"));
  const loading = screen.getByRole("status");
  assert.equal(loading.getAttribute("aria-busy"), "true");
  assert.equal(loading.textContent, "Loading viewers…");
  assert.ok(within(screen.getByRole("alert")).getByText("Could not load: 500 boom"));
  await user.click(screen.getByRole("button", { name: "Retry" }));
  assert.equal(retried, 1);
});

// @spec DASH-A11Y-008
test("an Icon is decorative: aria-hidden, not focusable", () => {
  const { container } = render(<Icon name="external" />);
  const svg = container.querySelector("svg")!;
  assert.equal(svg.getAttribute("aria-hidden"), "true");
  assert.equal(svg.getAttribute("focusable"), "false");
});
