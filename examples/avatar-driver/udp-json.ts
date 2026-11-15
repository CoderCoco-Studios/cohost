// An example avatar driver: it sends each call to the avatar app as one JSON datagram over UDP, so any program that can
// read a UDP socket can animate a model. Not registered in services/avatar/src/drivers/index.ts: the Add an avatar
// driver page walks the three edits that would.
import { createSocket, type Socket } from "node:dgram";
import type { AvatarDriver, AvatarParams, DriverContext } from "../../services/avatar/src/types.ts";

// #region driver
export class UdpJsonDriver implements AvatarDriver { // @spec AVATAR-EX-001, AVATAR-EX-002, AVATAR-EX-003, AVATAR-EX-004
  readonly name = "udp-json";
  private sock?: Socket;
  private ctx?: DriverContext;

  private readonly opts: { host: string; port: number };

  constructor(opts: { host: string; port: number }) { this.opts = opts; }

  connected(): boolean { return this.sock !== undefined; }

  async connect(ctx: DriverContext): Promise<void> {
    this.ctx = ctx;
    const sock = createSocket("udp4");
    sock.on("error", (err) => this.failed(err));
    this.sock = sock;
    ctx.log.info({ host: this.opts.host, port: this.opts.port }, "udp-json driver ready");
  }

  async disconnect(): Promise<void> {
    const sock = this.sock;
    this.sock = undefined;
    try { sock?.close(); } catch { /* already closed */ }
  }

  /** The engine calls this at frame rate with the smoothed state: send it as it is. */
  setParams(p: AvatarParams): void {
    this.send({ type: "params", ...p });
  }

  /** `emotion` is a canonical name; expressions.yaml says what the app calls it. */
  setExpression(emotion: string, intensity: number): void {
    this.send({ type: "expression", name: this.ctx?.expressions[emotion] || emotion, intensity });
  }

  trigger(gesture: string): void {
    this.send({ type: "gesture", name: this.ctx?.gestures[gesture] || gesture });
  }

  /** One datagram per call. A failure is logged, never thrown: the engine calls this every frame. */
  private send(message: Record<string, unknown>): void {
    const sock = this.sock;
    if (!sock) return;
    try {
      sock.send(JSON.stringify(message), this.opts.port, this.opts.host, (err) => { if (err) this.failed(err); });
    } catch (err) {
      this.failed(err);
    }
  }

  private failed(err: unknown): void {
    this.ctx?.log.warn({ err: err instanceof Error ? err.message : String(err), ...this.opts }, "udp-json send failed");
  }
}
// #endregion driver
