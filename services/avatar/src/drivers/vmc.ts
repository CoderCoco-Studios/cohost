/**
 * VMC protocol driver (3D / VRM). Sends OSC over UDP, which VSeeFace, Warudo,
 * VNyan, VMagicMirror and most VRM apps accept as a "VMC receiver" (default port 39539).
 *
 * - Lip-sync / blink / expressions -> /VMC/Ext/Blend/Val + /VMC/Ext/Blend/Apply
 * - Head pose -> /VMC/Ext/Bone/Pos "Head" (local rotation quaternion)
 *
 * expressions.yaml values are blendshape names. VRM 0.x presets: Neutral Joy Angry
 * Sorrow Fun Surprised Blink A I U E O. VRM 1.0 uses lowercase (happy, aa, blink...),
 * so the driver sends mouth as both "A" and "aa" and blink as both "Blink"/"blink".
 */
import dgram from "node:dgram";
import type { Emotion } from "@cohost/config";
import type { AvatarDriver, AvatarParams, Capability, DriverContext } from "../types.js";

export class VmcDriver implements AvatarDriver {
  readonly name = "vmc";
  private sock?: dgram.Socket;
  private ctx!: DriverContext;
  private activeExpr?: string;
  private exprValue = 0;

  constructor(private opts: { host: string; port: number }) {}

  capabilities(): ReadonlySet<Capability> {
    return new Set<Capability>(["expressions", "params", "lipsync"]);
  }
  connected() { return !!this.sock; }

  async connect(ctx: DriverContext): Promise<void> {
    this.ctx = ctx;
    this.sock = dgram.createSocket("udp4");
    this.ctx.log.info({ host: this.opts.host, port: this.opts.port }, "vmc sender ready (UDP, fire-and-forget)");
  }
  async disconnect(): Promise<void> { this.sock?.close(); this.sock = undefined; }

  setParams(p: AvatarParams): void {
    if (!this.sock) return;
    const q = eulerToQuat(p.headY, p.headX, p.headZ);
    const msgs: Buffer[] = [
      osc("/VMC/Ext/Bone/Pos", ["Head", 0, 0, 0, q[0], q[1], q[2], q[3]]),
      osc("/VMC/Ext/Blend/Val", ["A", p.mouthOpen]),
      osc("/VMC/Ext/Blend/Val", ["aa", p.mouthOpen]),
      osc("/VMC/Ext/Blend/Val", ["Blink", p.blink]),
      osc("/VMC/Ext/Blend/Val", ["blink", p.blink]),
    ];
    if (this.activeExpr) msgs.push(osc("/VMC/Ext/Blend/Val", [this.activeExpr, this.exprValue]));
    msgs.push(osc("/VMC/Ext/Blend/Apply", []));
    msgs.push(osc("/VMC/Ext/OK", [1]));
    for (const m of msgs) this.sock.send(m, this.opts.port, this.opts.host);
  }

  setExpression(emotion: Emotion, intensity: number): void {
    const target = this.ctx.expressions[emotion];
    if (this.activeExpr && this.activeExpr !== target && this.sock) {
      this.sock.send(osc("/VMC/Ext/Blend/Val", [this.activeExpr, 0]), this.opts.port, this.opts.host);
    }
    this.activeExpr = target;
    this.exprValue = Math.max(0, Math.min(1, intensity));
  }

  trigger(_gesture: string): void { /* VMC has no gesture concept; use a vnyan/warudo driver for that */ }
}

// ---- minimal OSC encoder (strings, int32, float32) — enough for VMC.
function osc(address: string, args: (string | number)[]): Buffer {
  const parts: Buffer[] = [oscString(address)];
  let tags = ",";
  const body: Buffer[] = [];
  for (const a of args) {
    if (typeof a === "string") { tags += "s"; body.push(oscString(a)); }
    else if (Number.isInteger(a) && address.endsWith("/OK")) { tags += "i"; const b = Buffer.alloc(4); b.writeInt32BE(a); body.push(b); }
    else { tags += "f"; const b = Buffer.alloc(4); b.writeFloatBE(a); body.push(b); }
  }
  parts.push(oscString(tags), ...body);
  return Buffer.concat(parts);
}
function oscString(s: string): Buffer {
  const len = Buffer.byteLength(s) + 1;
  const pad = (4 - (len % 4)) % 4;
  const b = Buffer.alloc(len + pad);
  b.write(s, "utf8");
  return b;
}
/** pitch/yaw/roll in degrees -> [x,y,z,w] */
function eulerToQuat(pitch: number, yaw: number, roll: number): [number, number, number, number] {
  const r = Math.PI / 180;
  const cy = Math.cos(yaw * r / 2), sy = Math.sin(yaw * r / 2);
  const cp = Math.cos(pitch * r / 2), sp = Math.sin(pitch * r / 2);
  const cr = Math.cos(roll * r / 2), sr = Math.sin(roll * r / 2);
  return [
    sp * cy * cr - cp * sy * sr,
    cp * sy * cr + sp * cy * sr,
    cp * cy * sr - sp * sy * cr,
    cp * cy * cr + sp * sy * sr,
  ];
}
