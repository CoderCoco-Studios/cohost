// The renderer page's entry (`avatar.html`): wires the socket, the pure state and the load to the WebGL layer. Its one
// draw per animation frame (DASH-AVP-031) reads the snapshot, applies the pose and framing, steps the model and renders.
import { canvasSize, clampStepSeconds, framingPlan } from "./framing";
import { createReconnect } from "./reconnect";
import { contextLossWait } from "./context-loss";
import { createModelLoader, type ModelReport } from "./model-loader";
import { acceptDraft, statusLine } from "./preview";
import { showStatusLine } from "./status-dom";
import { createAvatarState, SOCKET_PATH } from "./session";
import { applyFraming, applyPose, createStage, disposeVrm, loadVrm, type LoadedModel } from "./scene";
import "./avatar.css";

const preview = new URLSearchParams(location.search).get("preview") === "1";
const canvas = document.getElementById("stage") as HTMLCanvasElement;
const statusEl = document.getElementById("status") as HTMLElement;
const stage = createStage(canvas);

let loadState: { state: "idle" | "loading" | "ready" | "failed"; detail: string } = { state: "idle", detail: "" };
let socket: WebSocket | null = null;

/** Sends one message to the relay; nothing goes while the socket is closed. */
function send(msg: object): void {
  if (socket !== null && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
}

function refreshStatus(): void {
  if (!preview) return;
  const snap = state.snapshot();
  showStatusLine(statusEl, statusLine({
    socketOpen: snap.socketOpen,
    model: snap.modelName === null ? null : { name: snap.modelName },
    load: loadState,
    status: snap.status,
  }));
}

const loader = createModelLoader<LoadedModel>({
  fetchModel: (url, { signal, bypassCache }) => fetch(url, { signal, cache: bypassCache ? "reload" : "default", credentials: "omit" }),
  build: (bytes, signal) => loadVrm(stage, bytes, signal),
  dispose: (m) => disposeVrm(stage, m),
  report: (r: ModelReport) => {
    loadState = { state: r.state, detail: r.detail };
    // A preview never reports: a loopback page must not overwrite the owner's health line for the real OBS page (owner ruling 5).
    if (!preview) send({ type: "model", version: r.version, state: r.state, detail: r.detail });
    refreshStatus();
  },
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (id) => window.clearTimeout(id),
});

const state = createAvatarState({
  preview,
  now: () => performance.now(),
  loader: { request: (t) => loader.request(t), clear: () => loader.clear() },
});

// The socket: reconnects with the schedule of DASH-AVP-033.
const reconnect = createReconnect();
function connect(): void {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const sock = new WebSocket(`${proto}//${location.host}${SOCKET_PATH(preview)}`);
  socket = sock;
  let openedAt: number | null = null;
  sock.onopen = () => { openedAt = performance.now(); state.socketOpen(true); refreshStatus(); };
  sock.onmessage = (e: MessageEvent) => { if (typeof e.data === "string") { state.message(e.data); refreshStatus(); } };
  sock.onclose = () => {
    socket = null;
    state.socketOpen(false);
    const delay = reconnect.onClose(openedAt === null ? null : performance.now() - openedAt);
    refreshStatus();
    window.setTimeout(connect, delay);
  };
}
connect();

// Drafts from the embedding window (preview only, DASH-AVP-036).
window.addEventListener("message", (e: MessageEvent) => {
  const draft = acceptDraft({ data: e.data, origin: e.origin, source: e.source }, {
    preview,
    origin: location.origin,
    parent: window.parent === window ? null : window.parent,
  });
  if (draft !== null) { state.draft(draft); refreshStatus(); }
});

// WebGL context loss (DASH-AVP-034): wait, and reload if the context has not come back.
let lossTimer: number | undefined;
canvas.addEventListener("webglcontextlost", (e) => {
  e.preventDefault();
  let storage: Pick<Storage, "getItem" | "setItem">;
  try { storage = window.sessionStorage; } catch { storage = { getItem: () => null, setItem: () => undefined }; }
  const wait = contextLossWait(storage, Date.now());
  lossTimer = window.setTimeout(() => { window.location.reload(); }, wait);
});
canvas.addEventListener("webglcontextrestored", () => {
  window.clearTimeout(lossTimer);
  lossTimer = undefined;
  refreshStatus();
});

// The draw: once per animation frame while the document is visible (requestAnimationFrame pauses when it is not).
let last = performance.now();
function draw(): void {
  requestAnimationFrame(draw);
  const now = performance.now();
  const step = clampStepSeconds(now - last);
  last = now;
  stage.fit(canvasSize({ width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio }));
  const snap = state.snapshot();
  const model = loader.current();
  if (model !== null) {
    applyFraming(stage, framingPlan(model.box, snap.framing));
    applyPose(model, snap.pose);
    model.vrm.update(step);
  }
  stage.render();
}
requestAnimationFrame(draw);
