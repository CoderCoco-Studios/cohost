// Render helpers. Import this (not @testing-library/react) in a UI test: it loads the DOM first, registers cleanup
// after each test, and re-exports the queries a test needs.
import "./dom";
import { afterEach } from "node:test";
import type { ReactElement } from "react";
import { cleanup, render as rtlRender, screen, within, fireEvent, waitFor, act, type RenderResult } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppProviders } from "../../../ui/src/app/providers";
import { createRuntime, type Runtime, type RuntimeDeps } from "../../../ui/src/state/runtime";
import { FakeClock, FakeFetch, FakeSocket, FakeStorage } from "./fakes";

afterEach(() => { cleanup(); });

export { screen, within, fireEvent, waitFor, act, userEvent };

export function render(ui: ReactElement): RenderResult { return rtlRender(ui); }

export interface TestApp {
  rt: Runtime;
  fetch: FakeFetch;
  clock: FakeClock;
  /** The `/ws` socket the feed opened (open it with `socket.open()`, push frames with `socket.message(...)`). */
  socket: () => FakeSocket;
  local: FakeStorage;
  session: FakeStorage;
}

/**
 * A runtime wired to fakes: a route-table `fetch`, a controllable `/ws` socket, in-memory storage and a manual clock.
 * `fetch.on("GET /services/control", { json: { runtime: "compose", advanced: false, unlocked: false } })` answers a route; an unanswered one is a 404.
 */
export function makeApp(over: Partial<RuntimeDeps> = {}): TestApp {
  FakeSocket.reset();
  const fetch = new FakeFetch();
  const clock = new FakeClock();
  const local = new FakeStorage(), session = new FakeStorage();
  const rt = createRuntime({
    fetch: fetch.fetch, local, session, events: new EventTarget(), themeRoot: document.createElement("html"),
    createSocket: (u) => new FakeSocket(u) as unknown as WebSocket, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, now: () => clock.now,
    wsUrl: "ws://localhost:3000/ws", ...over,
  });
  return { rt, fetch, clock, socket: () => FakeSocket.last(), local, session };
}

/** Renders `ui` inside the runtime providers (access, api, feed, theme, audio) of a `makeApp()`. */
export function renderApp(ui: ReactElement, app: TestApp = makeApp()): RenderResult & { app: TestApp } {
  const r = rtlRender(<AppProviders runtime={app.rt}>{ui}</AppProviders>);
  return Object.assign(r, { app });
}
