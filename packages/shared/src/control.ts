import type { BusEvent } from "@cohost/bus";
import type { Logger } from "@cohost/config";
import type { Heartbeat } from "./lifecycle.js";

export type ControlData = BusEvent<"control">["data"];
type ControlHandler = (data: ControlData) => void | Promise<void>;

/** The service's reaction to each command; a command it gave no handler for only updates the reader's own state. */
export interface ControlHandlers {
  pause?: ControlHandler;
  resume?: ControlHandler;
  mute?: ControlHandler;
  unmute?: ControlHandler;
  forget_context?: ControlHandler;
  reload_personality?: ControlHandler;
  say?: ControlHandler;
  /** mouth: re-route its outputs live (MOUTH-LIVE-001). */
  set_routing?: ControlHandler;
}

export interface ControlOptions {
  log?: Pick<Logger, "error">;
  /** Given the service's heartbeat, the standing detail is `paused` while paused. */
  heartbeat?: Pick<Heartbeat, "setDetail">;
}

export interface ControlReader {
  readonly paused: boolean;
  readonly muted: boolean;
  /** Increased by `pause` and `forget_context`, so work queued under an older epoch can be discarded. */
  readonly epoch: number;
  /** Apply a `control` event: true for any `control` event (applied or addressed to another service), false for any other. Handlers are not awaited. */
  handle(ev: BusEvent): boolean;
  /** `handle`, resolving once the service's handler has finished. */
  handleAsync(ev: BusEvent): Promise<boolean>;
}

/**
 * The one reader of `control` events for a service that honours them (salience, cortex, affect, mouth): target filter,
 * `paused` / `muted` / `epoch` state and dispatch to the service's handlers.
 */
// @spec SHARED-CTRL-001, SHARED-CTRL-002, SHARED-CTRL-003, SHARED-CTRL-004, SHARED-CTRL-005, SHARED-CTRL-006, SHARED-CTRL-007
export function controlFor(service: string, handlers: ControlHandlers = {}, opts: ControlOptions = {}): ControlReader {
  let paused = false;
  let muted = false;
  let epoch = 0;

  async function apply(d: ControlData): Promise<void> {
    switch (d.cmd) {
      case "pause": paused = true; epoch++; opts.heartbeat?.setDetail("paused"); break;
      case "resume": paused = false; opts.heartbeat?.setDetail(undefined); break;
      case "mute": muted = true; break;
      case "unmute": muted = false; break;
      case "forget_context": epoch++; break;
      default: break;
    }
    const handler = handlers[d.cmd];
    if (!handler) return;
    try {
      await handler(d);
    } catch (err) {
      opts.log?.error({ err, cmd: d.cmd, service }, "control handler failed");
    }
  }

  const reader: ControlReader = {
    get paused() { return paused; },
    get muted() { return muted; },
    get epoch() { return epoch; },
    handle(ev) {
      if (ev.type !== "control") return false;
      void reader.handleAsync(ev);
      return true;
    },
    async handleAsync(ev) {
      if (ev.type !== "control") return false;
      const d = ev.data as ControlData;
      if (d.target && d.target !== service) return true;
      await apply(d);
      return true;
    },
  };
  return reader;
}
