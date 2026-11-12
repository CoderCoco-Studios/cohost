/**
 * VTube Studio driver (Live2D). Talks the VTS public WebSocket API
 * (default ws://127.0.0.1:8001). First connect pops an "Allow plugin?" dialog
 * in VTS; the token is saved to <config>/.vts-token so it only happens once.
 *
 * VTS must have the API enabled: Settings > General > "Start API (allow plugins)".
 * From another machine / WSL / Docker, VTS listens on all interfaces by default.
 *
 * expressions.yaml values can be either a hotkey *name* (toggled on/off) or an
 * expression file like "smug.exp3.json" (activated/deactivated explicitly).
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { Emotion } from "@cohost/config";
import { retryWithBackoff, singleFlight } from "@cohost/shared";
import type { AvatarDriver, AvatarParams, DriverContext } from "../types.js";

interface Hotkey { name: string; type: string; hotkeyID: string }

/** The driver's connection settings; the three timings default to 5 s and exist so a test need not wait that long. */
export interface VTubeStudioOptions {
  host: string;
  port: number;
  pluginName: string;
  pluginDeveloper: string;
  /** A WebSocket handshake not completed in this time is abandoned (AVATAR-VTS-016). */
  handshakeTimeoutMs?: number;
  /** Delay between reconnect attempts (AVATAR-VTS-007). */
  reconnectMs?: number;
  /** Time a request waits for its reply (AVATAR-VTS-006). */
  requestTimeoutMs?: number;
}

const DEFAULT_TIMING_MS = 5000;

export class VTubeStudioDriver implements AvatarDriver {
  readonly name = "vtube-studio";
  private ws?: WebSocket;
  private ctx!: DriverContext;
  private ready = false;
  private pending = new Map<string, { resolve: (d: unknown) => void; reject: (e: Error) => void }>();
  private hotkeys = new Map<string, Hotkey>();
  private activeExpr?: string;
  private failLoggedAt = new Map<string, number>();
  private cancelWait?: () => void;
  private closing = false;

  constructor(private opts: VTubeStudioOptions) {}

  connected() { return this.ready; }

  async connect(ctx: DriverContext): Promise<void> { // @spec AVATAR-VTS-001, AVATAR-VTS-002
    this.ctx = ctx;
    this.closing = false;
    await this.open();
  }

  async disconnect(): Promise<void> { // @spec AVATAR-VTS-007
    this.closing = true;
    this.cancelWait?.();
    this.ws?.close();
    this.ready = false;
  }

  // ---- params: injected every frame. VTS resets injected values after ~1s of silence.
  setParams(p: AvatarParams): void { // @spec AVATAR-VTS-008, AVATAR-VTS-012
    if (!this.ready) return;
    this.fire("params", this.send("InjectParameterDataRequest", {
      faceFound: true,
      mode: "set",
      parameterValues: [
        { id: "MouthOpen", value: clamp(p.mouthOpen, 0, 1) },
        { id: "MouthSmile", value: clamp(p.mouthSmile, 0, 1) },
        { id: "FaceAngleX", value: clamp(p.headX, -30, 30) },
        { id: "FaceAngleY", value: clamp(p.headY, -30, 30) },
        { id: "FaceAngleZ", value: clamp(p.headZ, -30, 30) },
        { id: "EyeLeftX", value: clamp(p.eyeX, -1, 1) },
        { id: "EyeRightX", value: clamp(p.eyeX, -1, 1) },
        { id: "EyeLeftY", value: clamp(p.eyeY, -1, 1) },
        { id: "EyeRightY", value: clamp(p.eyeY, -1, 1) },
        { id: "EyeOpenLeft", value: clamp(1 - p.blink, 0, 1) },
        { id: "EyeOpenRight", value: clamp(1 - p.blink, 0, 1) },
      ],
    }, false));
  }

  setExpression(emotion: Emotion, intensity: number): void { // @spec AVATAR-VTS-009, AVATAR-VTS-012
    if (!this.ready) return;
    const target = intensity > 0.05 ? this.ctx.expressions[emotion] : undefined;
    if (target === this.activeExpr) return;
    if (this.activeExpr) this.fire("expression", this.activate(this.activeExpr, false));
    if (target) this.fire("expression", this.activate(target, true));
    this.activeExpr = target;
  }

  trigger(gesture: string): void { // @spec AVATAR-VTS-011, AVATAR-VTS-012
    if (!this.ready) return;
    const name = this.ctx.gestures[gesture];
    if (!name) return;
    const hk = this.hotkeys.get(name.toLowerCase());
    if (!hk) { this.ctx.log.warn({ gesture, name }, "gesture hotkey not found in VTS"); return; }
    this.fire("gesture", this.send("HotkeyTriggerRequest", { hotkeyID: hk.hotkeyID }));
  }

  // ---- internals
  /** Absorb a fire-and-forget request's failure (APIError, timeout, closed socket): log it, at most every 5 s per kind. */
  private fire(kind: "params" | "expression" | "gesture", request: Promise<unknown>): void { // @spec AVATAR-VTS-014
    request.catch((err) => {
      const now = performance.now(); // an interval is a duration: a stepped wall clock must not open or shut it
      if (now - (this.failLoggedAt.get(kind) ?? -Infinity) < 5000) return;
      this.failLoggedAt.set(kind, now);
      this.ctx.log.warn({ err: err instanceof Error ? err.message : String(err), kind }, "vts request failed");
    });
  }

  private async activate(name: string, on: boolean) { // @spec AVATAR-VTS-010
    if (name.endsWith(".exp3.json")) {
      await this.send("ExpressionActivationRequest", { expressionFile: name, active: on });
      return;
    }
    const hk = this.hotkeys.get(name.toLowerCase());
    if (!hk) { this.ctx.log.warn({ name }, "expression hotkey not found in VTS"); return; } // @spec AVATAR-VTS-015
    // Hotkeys toggle; we only know our own bookkeeping, so trigger on both on and off.
    await this.send("HotkeyTriggerRequest", { hotkeyID: hk.hotkeyID });
  }

  private get reconnectMs(): number { return this.opts.reconnectMs ?? DEFAULT_TIMING_MS; }

  private tokenFile() { return join(this.ctx.stateDir, ".vts-token"); }

  /** One attempt; rejects unless the socket opened and authenticated. */
  private async dial(): Promise<void> {
    await this.open();
    if (!this.ready) throw new Error("vts is not connected");
  }

  /** After a drop or a failed connect: dial again every 5 s until connected or `disconnect()`; concurrent triggers share one loop. */
  // @spec AVATAR-VTS-007
  private reconnect = singleFlight(async (): Promise<void> => {
    await retryWithBackoff(() => this.dial(), {
      baseMs: this.reconnectMs, maxMs: this.reconnectMs, factor: 1, firstDelayMs: this.reconnectMs,
      isStopped: () => this.closing,
      sleep: (ms) => new Promise<void>((resolve) => {
        const t = setTimeout(done, ms);
        function done() { clearTimeout(t); resolve(); }
        this.cancelWait = done;
      }),
      onFailure: () => { if (!this.closing) this.ctx.log.warn({ retryMs: this.reconnectMs }, "vts not reachable, retrying"); },
    });
  });

  private open(): Promise<void> {
    return new Promise((resolve) => {
      const url = `ws://${this.opts.host}:${this.opts.port}`;
      this.activeExpr = undefined; // @spec AVATAR-VTS-013
      const ws = new WebSocket(url, { handshakeTimeout: this.opts.handshakeTimeoutMs ?? DEFAULT_TIMING_MS }); // @spec AVATAR-VTS-016
      this.ws = ws;
      ws.on("open", async () => {
        this.ctx.log.info({ url }, "vts socket open");
        try {
          await this.authenticate();
          await this.loadHotkeys();
          this.ready = true;
          this.ctx.log.info({ hotkeys: this.hotkeys.size }, "vts authenticated");
        } catch (err) { // @spec AVATAR-VTS-005
          this.ctx.log.error({ err }, "vts auth failed");
          ws.close();
        }
        resolve();
      });
      ws.on("message", (raw) => this.onMessage(String(raw)));
      ws.on("close", () => { // @spec AVATAR-VTS-007
        this.ready = false;
        this.activeExpr = undefined; // @spec AVATAR-VTS-013
        for (const p of this.pending.values()) p.reject(new Error("socket closed"));
        this.pending.clear();
        if (!this.closing) {
          this.ctx.log.warn({ retryMs: this.reconnectMs }, "vts disconnected, retrying");
          void this.reconnect();
        }
      });
      ws.on("error", (err) => {
        this.ctx.log.warn({ err: err.message }, "vts socket error");
        resolve(); // don't block startup; close handler schedules the retry
      });
    });
  }

  private async authenticate() { // @spec AVATAR-VTS-003
    const { pluginName, pluginDeveloper } = this.opts;
    let token = existsSync(this.tokenFile()) ? readFileSync(this.tokenFile(), "utf8").trim() : "";
    if (!token) {
      this.ctx.log.info("requesting VTS plugin token — click Allow in VTube Studio");
      const r = (await this.send("AuthenticationTokenRequest", { pluginName, pluginDeveloper }, true, 60_000)) as { authenticationToken: string };
      token = r.authenticationToken;
      writeFileSync(this.tokenFile(), token);
    }
    const auth = (await this.send("AuthenticationRequest", { pluginName, pluginDeveloper, authenticationToken: token })) as { authenticated: boolean; reason?: string };
    if (!auth.authenticated) { // @spec AVATAR-VTS-004
      writeFileSync(this.tokenFile(), "");
      throw new Error(`VTS rejected token: ${auth.reason}`);
    }
  }

  private async loadHotkeys() {
    const r = (await this.send("HotkeysInCurrentModelRequest", {})) as { availableHotkeys?: Hotkey[] };
    this.hotkeys.clear();
    for (const h of r.availableHotkeys ?? []) this.hotkeys.set(h.name.toLowerCase(), h);
  }

  private send(messageType: string, data: unknown, expectReply = true, timeoutMs = this.opts.requestTimeoutMs ?? DEFAULT_TIMING_MS): Promise<unknown> { // @spec AVATAR-VTS-006
    const requestID = randomUUID();
    const msg = JSON.stringify({ apiName: "VTubeStudioPublicAPI", apiVersion: "1.0", requestID, messageType, data });
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("vts not connected"));
    this.ws.send(msg);
    if (!expectReply) return Promise.resolve(undefined);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(requestID); reject(new Error(`${messageType} timed out`)); }, timeoutMs);
      this.pending.set(requestID, {
        resolve: (d) => { clearTimeout(t); resolve(d); },
        reject: (e) => { clearTimeout(t); reject(e); },
      });
    });
  }

  private onMessage(raw: string) {
    let msg: { requestID?: string; messageType?: string; data?: unknown };
    try { msg = JSON.parse(raw); } catch { return; }
    const p = msg.requestID ? this.pending.get(msg.requestID) : undefined;
    if (!p) return;
    this.pending.delete(msg.requestID!);
    if (msg.messageType === "APIError") {
      const d = msg.data as { errorID?: number; message?: string };
      p.reject(new Error(`VTS error ${d.errorID}: ${d.message}`));
    } else p.resolve(msg.data);
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
