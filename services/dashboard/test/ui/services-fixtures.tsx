// Shared fixtures for the Services screen tests (services*.test.tsx): a manifest, service and stack snapshots, and a
// `mountServices` that renders the screen against a fake runtime and answers the control and manifest reads.
import { act, makeApp, renderApp, screen, type TestApp } from "./helpers/render";
import { Screen } from "../../ui/src/screens/services";
import type { ControlInfo, HealthState, ServiceHealth, StackSnapshot, UnitDescriptor } from "../../ui/src/state/types";

const unit = (id: string, over: Partial<UnitDescriptor> & { inputs?: string[]; observe?: string[] } = {}): UnitDescriptor => {
  const { inputs = [], observe = [], ...rest } = over;
  return { id, config: [], uses: [], requires: [], pause: false, test: { inputs, observe }, infra: false, defaultMode: "fresh", ...rest };
};

/** A manifest shaped like the control plane's (ids, pause flags and test declarations), without the full list. */
export const UNITS: UnitDescriptor[] = [
  unit("chat", { inputs: ["text"], observe: ["chat.message", "inject.result"] }),
  unit("salience", { pause: true, inputs: ["chat.message", "speech.heard", "vision.summary"], observe: ["attention.focus", "brain.say"] }),
  unit("cortex", { pause: true, inputs: ["attention.focus"], observe: ["brain.status", "brain.say"] }),
  unit("voice", { inputs: ["brain.say"], observe: ["voice.utterance"] }),
  unit("eyes", { inputs: ["image"], observe: ["vision.summary", "inject.result"] }),
  unit("ears", { inputs: ["audio"], observe: ["speech.heard", "inject.result"] }),
  unit("memory"),
  unit("redis", { infra: true }),
];

export const beat = (over: Record<string, unknown> = {}) => ({ service: "x", mode: "live", deps: {}, startedAt: 1, ...over });
export const svc = (service: string, over: Partial<ServiceHealth> = {}): ServiceHealth => ({ service, state: "up" as HealthState, restarts: 0, lastSeenAgeMs: 1000, heartbeat: beat({ service }), ...over });

export const stackMsg = (over: Partial<StackSnapshot> = {}): StackSnapshot => ({ state: "up", docker: { ok: true }, bus: "connected", action: null, last: null, services: [], ...over });

export interface MountOptions {
  control?: ControlInfo | "fail";
  manifest?: UnitDescriptor[] | "fail";
  services?: ServiceHealth[];
  stack?: StackSnapshot;
  app?: TestApp;
}

/** Renders the screen, opens the socket and sends the snapshots; resolves once the control and manifest reads have landed. */
export async function mountServices(o: MountOptions = {}) {
  const app = o.app ?? makeApp();
  const control = o.control ?? { runtime: "compose", advanced: false, unlocked: false };
  if (control === "fail") app.fetch.on("GET /services/control", { status: 500, text: "boom" });
  else app.fetch.on("GET /services/control", { json: control });
  const manifest = o.manifest ?? UNITS;
  if (manifest === "fail") app.fetch.on("GET /services/manifest", { status: 500, text: "manifest unreadable" });
  else app.fetch.on("GET /services/manifest", { json: { units: manifest } });
  const r = renderApp(<Screen route={{ view: "services" }} />, app);
  act(() => app.socket().open());
  if (o.services) act(() => app.socket().message({ type: "services", services: o.services }));
  if (o.stack) act(() => app.socket().message({ type: "stack", ...o.stack }));
  await act(async () => { await Promise.resolve(); });
  await screen.findByRole("heading", { level: 1, name: "Services" });
  // let the two reads settle
  await act(async () => { await new Promise((res) => setTimeout(res, 0)); });
  return { ...r, app };
}

/** Pushes a services snapshot and/or a stack message through the open socket. */
export function push(app: TestApp, frame: Record<string, unknown>): void { act(() => app.socket().message(frame)); }
