import type { Emotion } from "@cohost/config";
import type { AvatarDriver, AvatarParams, Capability, DriverContext } from "../types.js";

/** No avatar app. Logs expression changes; the dashboard preview shows the state. */
export class NullDriver implements AvatarDriver {
  readonly name = "null";
  private log?: DriverContext["log"];
  capabilities(): ReadonlySet<Capability> { return new Set<Capability>(["expressions", "params", "gestures", "lipsync"]); }
  async connect(ctx: DriverContext) { this.log = ctx.log; this.log.info("null driver: no avatar app, dashboard preview only"); }
  async disconnect() {}
  connected() { return true; }
  setParams(_p: AvatarParams) {}
  setExpression(emotion: Emotion, intensity: number) { this.log?.debug({ emotion, intensity }, "expression"); }
  trigger(gesture: string) { this.log?.debug({ gesture }, "gesture"); }
}
