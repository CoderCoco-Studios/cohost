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
import type { AvatarDriver, AvatarParams, Capability, DriverContext } from "../types.js";

interface Hotkey { name: string; type: string; hotkeyID: string }

export class VTubeStudioDriver implements AvatarDriver {
  readonly name = "vtube-studio";
  private ws?: WebSocket;
  private ctx!: DriverContext;
  private ready = false;
  private pending = new Map<string, { resolve: (d: unknown) => void; reject: (e: Error) => void }>();
  private hotkeys = new Map<string, Hotkey>();
  private activeExpr?: string;
  private reconnectTimer?: NodeJS.Timeout;
  private closing = false;

  constructor(private opts: { host: string; port: number; pluginName: string; pluginDeveloper: string }) {}

  capabilities(): ReadonlySet<Capability> {
    return new Set<Capability>(["expressions", "params", "gestures", "lipsync"]);
  }
  connected() { return this.ready; }

  async connect(ctx: DriverContext): Promise<void> {
    this.ctx = ctx;
    this.closing = false;
    await this.open();
  }

  async disconnect(): Promise<void> {
    this.closing = true;
    clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ready = false;
  }

  // ---- params: injected every frame. VTS resets injected values after ~1s of silence.
  setParams(p: AvatarParams): void {
    if (!this.ready) return;
    void this.send("InjectParameterDataRequest", {
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
    }, false);
  }

  setExpression(emotion: Emotion, intensity: number): void {
    if (!this.ready) return;
    const target = intensity > 0.05 ? this.ctx.expressions[emotion] : undefined;
    if (target === this.activeExpr) return;
    if (this.activeExpr) void this.activate(this.activeExpr, false);
    if (target) void this.activate(target, true);
    this.activeExpr = target;
  }

  trigger(gesture: string): void {
    if (!this.ready) return;
    const name = this.ctx.gestures[gesture];
    if (!name) return;
    const hk = this.hotkeys.get(name.toLowerCase());
    if (!hk) { this.ctx.log.warn({ gesture, name }, "gesture hotkey not found in VTS"); return; }
    void this.send("HotkeyTriggerRequest", { hotkeyID: hk.hotkeyID });
  }

  // ---- internals
  private async activate(name: string, on: boolean) {
    if (name.endsWith(".exp3.json")) {
      await this.send("ExpressionActivationRequest", { expressionFile: name, active: on });
      return;
    }
    const hk = this.hotkeys.get(name.toLowerCase());
    if (!hk) { this.ctx.log.warn({ name }, "expression hotkey not found in VTS"); return; }
    // Hotkeys toggle; we only know our own bookkeeping, so trigger on both on and off.
    await this.send("HotkeyTriggerRequest", { hotkeyID: hk.hotkeyID });
  }

  private tokenFile() { return join(this.ctx.stateDir, ".vts-token"); }

  private open(): Promise<void> {
    return new Promise((resolve) => {
      const url = `ws://${this.opts.host}:${this.opts.port}`;
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.on("open", async () => {
        this.ctx.log.info({ url }, "vts socket open");
        try {
          await this.authenticate();
          await this.loadHotkeys();
          this.ready = true;
          this.ctx.log.info({ hotkeys: this.hotkeys.size }, "vts authenticated");
        } catch (err) {
          this.ctx.log.error({ err }, "vts auth failed");
          ws.close();
        }
        resolve();
      });
      ws.on("message", (raw) => this.onMessage(String(raw)));
      ws.on("close", () => {
        this.ready = false;
        for (const p of this.pending.values()) p.reject(new Error("socket closed"));
        this.pending.clear();
        if (!this.closing) {
          this.ctx.log.warn("vts disconnected, retrying in 5s");
          this.reconnectTimer = setTimeout(() => void this.open(), 5000);
        }
      });
      ws.on("error", (err) => {
        this.ctx.log.warn({ err: err.message }, "vts socket error");
        resolve(); // don't block startup; close handler schedules the retry
      });
    });
  }

  private async authenticate() {
    const { pluginName, pluginDeveloper } = this.opts;
    let token = existsSync(this.tokenFile()) ? readFileSync(this.tokenFile(), "utf8").trim() : "";
    if (!token) {
      this.ctx.log.info("requesting VTS plugin token — click Allow in VTube Studio");
      const r = (await this.send("AuthenticationTokenRequest", { pluginName, pluginDeveloper }, true, 60_000)) as { authenticationToken: string };
      token = r.authenticationToken;
      writeFileSync(this.tokenFile(), token);
    }
    const auth = (await this.send("AuthenticationRequest", { pluginName, pluginDeveloper, authenticationToken: token })) as { authenticated: boolean; reason?: string };
    if (!auth.authenticated) {
      writeFileSync(this.tokenFile(), "");
      throw new Error(`VTS rejected token: ${auth.reason}`);
    }
  }

  private async loadHotkeys() {
    const r = (await this.send("HotkeysInCurrentModelRequest", {})) as { availableHotkeys?: Hotkey[] };
    this.hotkeys.clear();
    for (const h of r.availableHotkeys ?? []) this.hotkeys.set(h.name.toLowerCase(), h);
  }

  private send(messageType: string, data: unknown, expectReply = true, timeoutMs = 5000): Promise<unknown> {
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
