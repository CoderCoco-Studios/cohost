// The renderer's relay-message handling and the view it keeps (DASH-AVP-020 to DASH-AVP-036). Pure: the clock, the
// loader and the preview flag are passed in, so no socket, DOM or 3D library is needed to drive it.
import { parseFrame, type Frame } from "./frame";
import { poseAt, type HeldFrame } from "./ease";
import { modelUrl } from "./loader-url";
import type { Framing } from "./framing";
import type { Draft } from "./preview";

/** The socket's path; the preview asks for `preview=1` (DASH-AVP-035). */
export const SOCKET_PATH = (preview: boolean): string => (preview ? "/avatar/ws?preview=1" : "/avatar/ws");

/** The driver state the relay reports (`status` messages). */
export interface AvatarStatus { state: "off" | "waiting" | "live"; driver: string | null }

export interface AvatarSnapshot {
  pose: Frame;
  framing: Framing;
  status: AvatarStatus | null;
  socketOpen: boolean;
  modelName: string | null;
}

/** The loader the session asks; `request` takes the URL and version of DASH-AVP-023, `clear` draws no model. */
export interface ModelRequests {
  request(target: { url: string; version: string }): void;
  clear(): void;
}

export interface AvatarStateOptions {
  preview: boolean;
  now(): number;
  loader: ModelRequests;
}

export interface AvatarState {
  /** Handles one text message of the socket; anything it does not accept is ignored. */
  message(raw: string): void;
  socketOpen(open: boolean): void;
  /** A preview's draft (DASH-AVP-036); ignored outside preview mode. */
  draft(d: Draft): void;
  snapshot(): AvatarSnapshot;
}

interface View {
  model: { version: string; name?: string } | null;
  framing: Framing;
}

const DEFAULT_FRAMING: Framing = { zoom: 1, offsetY: 0, turn: 0 };
const STATUS_STATES = ["off", "waiting", "live"] as const;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** A `view` (DASH-AVR-006): a model version or null, and a framing whose zoom is positive and whose numbers are finite (owner ruling 3). */
// @spec DASH-AVP-038
function parseView(m: Record<string, unknown>): View | null {
  let model: View["model"];
  if (m.model === null) model = null;
  else if (isObject(m.model) && typeof m.model.version === "string" && m.model.version !== "" && (m.model.name === undefined || typeof m.model.name === "string")) {
    model = m.model.name === undefined ? { version: m.model.version } : { version: m.model.version, name: m.model.name };
  } else return null;
  const f = m.framing;
  if (!isObject(f) || !finite(f.zoom) || f.zoom <= 0 || !finite(f.offsetY) || !finite(f.turn)) return null;
  return { model, framing: { zoom: f.zoom, offsetY: f.offsetY, turn: f.turn } };
}

function parseStatus(m: Record<string, unknown>): AvatarStatus | null {
  if (typeof m.state !== "string" || !(STATUS_STATES as readonly string[]).includes(m.state)) return null;
  if (m.driver !== null && typeof m.driver !== "string") return null;
  return { state: m.state as AvatarStatus["state"], driver: m.driver };
}

/**
 * The renderer's state: the last view, the drafts of a preview, the last valid frame and the socket flag. Each change it
 * asks the loader for what the model should be, once per change of version, so a framing-only view loads nothing.
 */
// @spec DASH-AVP-020, DASH-AVP-022, DASH-AVP-023, DASH-AVP-024, DASH-AVP-028, DASH-AVP-030, DASH-AVP-032
export function createAvatarState(opts: AvatarStateOptions): AvatarState {
  let view: View = { model: null, framing: { ...DEFAULT_FRAMING } };
  let draftModel: { name: string } | null = null;
  let draftFraming: Framing | null = null;
  let held: HeldFrame | null = null;
  let status: AvatarStatus | null = null;
  let socketIsOpen = false;
  /** What the loader was last asked for: a version, null for a cleared model, undefined before any request. */
  let sent: string | null | undefined;

  /** The model the page should show now, by the drafts of a preview first, then the view. */
  const desired = (): { url: string; version: string } | null => {
    if (opts.preview && draftModel !== null) {
      return draftModel.name === "" ? null : { url: modelUrl({ kind: "draft", name: draftModel.name }), version: `draft:${draftModel.name}` };
    }
    return view.model === null ? null : { url: modelUrl({ kind: "applied" }), version: view.model.version };
  };

  const apply = (): void => {
    const want = desired();
    if (want === null) {
      if (sent !== null) { opts.loader.clear(); sent = null; }
      return;
    }
    if (sent !== want.version) { opts.loader.request(want); sent = want.version; }
  };

  return {
    message(raw) {
      if (typeof raw !== "string") return;
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch { return; }
      if (!isObject(parsed)) return;
      switch (parsed.type) {
        case "view": {
          const v = parseView(parsed);
          if (v === null) return;
          view = v;
          apply();
          return;
        }
        case "frame": {
          const f = parseFrame(parsed.frame);
          if (f !== null) held = { frame: f, at: opts.now() };
          return;
        }
        case "status": {
          const s = parseStatus(parsed);
          if (s !== null) status = s;
          return;
        }
        default:
          return;
      }
    },
    socketOpen(open) { socketIsOpen = open; },
    draft(d) {
      if (!opts.preview) return;
      if (d.kind === "framing") { draftFraming = d.framing; return; }
      if (d.kind === "model") { draftModel = { name: d.name }; apply(); return; }
      draftModel = null;
      draftFraming = null;
      apply();
    },
    snapshot() {
      const modelName = opts.preview && draftModel !== null ? (draftModel.name === "" ? null : draftModel.name) : view.model === null ? null : view.model.name ?? "model";
      return {
        pose: poseAt(held, opts.now()),
        framing: opts.preview && draftFraming !== null ? { ...draftFraming } : { ...view.framing },
        status,
        socketOpen: socketIsOpen,
        modelName,
      };
    },
  };
}
