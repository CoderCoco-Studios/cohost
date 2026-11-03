import type { Publisher } from "@cohost/bus";
import type { Emotion, Logger } from "@cohost/config";
import type { AvatarParams } from "./types.js";

/** `avatar.state` goes out at most this often; 5 Hz is plenty for the dashboard preview. */
export const STATE_INTERVAL_MS = 200;
/** A failing publish is logged at most this often, however many frames fail in between. */
export const STATE_WARN_INTERVAL_MS = 10_000;

export interface StatePublisherDeps {
  bus: Publisher;
  driver: { name: string; connected(): boolean };
  log: Logger;
  now?: () => number;
}

/** The engine's `onState` callback: throttles to 5 Hz and publishes `avatar.state`; a failed publish is dropped. */
export function statePublisher(d: StatePublisherDeps): (p: AvatarParams, emotion: Emotion, intensity: number) => void { // @spec AVATAR-STATE-001, AVATAR-STATE-002
  const now = d.now ?? Date.now;
  let lastPublished = -Infinity;
  let lastWarned = -Infinity;
  return (p, emotion, intensity) => {
    const t = now();
    if (t - lastPublished < STATE_INTERVAL_MS) return;
    lastPublished = t;
    d.bus.publish("avatar.state", { ...p, emotion, intensity, driver: d.driver.name, connected: d.driver.connected() }).catch((err) => {
      if (t - lastWarned < STATE_WARN_INTERVAL_MS) return;
      lastWarned = t;
      d.log.warn({ err }, "avatar.state publish failed");
    });
  };
}
