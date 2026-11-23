/**
 * Local fake servers for the streaming STT adapters (#188): real sockets on 127.0.0.1, speaking the wire protocols the LLD
 * names (ears-design.md, STT engines). No model, no external network.
 *
 * Test seams the code phase must provide (the specs name none):
 *  - `createNemotronEngine(cfg: Config["ears"]): StreamingSttEngine` in `src/nemotron.ts`
 *  - `createKyutaiEngine(cfg: Config["ears"]): StreamingSttEngine` in `src/kyutai.ts`
 * Both read the `ears.*` section as `testConfig({ ears })` yields it, and `buildEngines` is handed the result as `streaming`.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { decode, encode } from "@msgpack/msgpack";
import { testConfig } from "@cohost/testing";

export const earsCfg = (ears: Record<string, unknown>) => testConfig({ ears }).ears;
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Polls `cond` every 5 ms until true; rejects after `ms`. */
export async function until(cond: () => boolean, what: string, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

interface Base {
  server: Server;
  wss: WebSocketServer;
  url: string;
  /** Every WebSocket upgrade request, in order. */
  upgrades: { url: string; headers: IncomingMessage["headers"] }[];
  sockets: WebSocket[];
  close(): Promise<void>;
}

async function listen(): Promise<{ server: Server; wss: WebSocketServer; url: string; sockets: WebSocket[]; upgrades: Base["upgrades"] }> {
  const server = createServer();
  const wss = new WebSocketServer({ server });
  const sockets: WebSocket[] = [];
  const upgrades: Base["upgrades"] = [];
  wss.on("connection", (ws, req) => { sockets.push(ws); upgrades.push({ url: req.url ?? "", headers: req.headers }); });
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  return { server, wss, sockets, upgrades, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const closer = (b: { server: Server; wss: WebSocketServer; sockets: WebSocket[] }) => async (): Promise<void> => {
  for (const s of b.sockets) s.terminate();
  for (const c of b.wss.clients) c.terminate();
  await new Promise<void>((res) => b.wss.close(() => res()));
  b.server.closeAllConnections();
  await new Promise<void>((res) => b.server.close(() => res()));
};

// ---------------------------------------------------------------------------------------------------- Nemotron

export type NemotronMsg = { binary: true; bytes: Buffer } | { binary: false; json: Record<string, unknown> };

export interface NemotronServer extends Base {
  /** Every message of every connection, in arrival order. */
  messages: NemotronMsg[];
  binary(): Buffer[];
  json(): Record<string, unknown>[];
  /** `GET /ready` requests seen. */
  readyGets: { url: string; headers: IncomingMessage["headers"] }[];
  /** Sends a JSON event to the latest connection. */
  send(ev: Record<string, unknown>): void;
  closeConnection(): void;
}

/**
 * A NeMo-Speech.cpp realtime server. By default it sends `session.created` at once, answers `input_audio_buffer.commit` with a
 * `...completed` event whose transcript is `transcript(this)`, and answers `GET /ready` with `ready()` (200 or 503).
 */
export async function nemotronServer(o: {
  /** Delay before `session.created`; `false` never sends it. */
  created?: number | false;
  /** The final of a commit; `false` means never answer. */
  transcript?: ((s: NemotronServer) => string) | false;
  ready?: () => number;
  /** Runs at every connection after `session.created` was scheduled. */
  onConnection?: (s: NemotronServer, ws: WebSocket) => void;
} = {}): Promise<NemotronServer> {
  const b = await listen();
  const messages: NemotronMsg[] = [];
  const readyGets: NemotronServer["readyGets"] = [];
  const s: NemotronServer = {
    ...b, close: closer(b), messages, readyGets,
    binary: () => messages.flatMap((m) => (m.binary ? [m.bytes] : [])),
    json: () => messages.flatMap((m) => (m.binary ? [] : [m.json])),
    send: (ev) => b.sockets.at(-1)!.send(JSON.stringify(ev)),
    closeConnection: () => b.sockets.at(-1)!.close(),
  };
  b.server.on("request", (req, res) => {
    if (req.method === "GET" && req.url?.startsWith("/ready")) {
      readyGets.push({ url: req.url, headers: req.headers });
      res.statusCode = o.ready ? o.ready() : 200;
      res.end("{}");
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  b.wss.on("connection", (ws) => {
    if (o.created !== false) setTimeout(() => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "session.created", session: { id: "s1" } })); }, o.created ?? 0);
    ws.on("message", (data, isBinary) => {
      if (isBinary) { messages.push({ binary: true, bytes: Buffer.from(data as Buffer) }); return; }
      const json = JSON.parse(data.toString()) as Record<string, unknown>;
      messages.push({ binary: false, json });
      if (json.type === "input_audio_buffer.commit" && o.transcript !== false) {
        const transcript = (o.transcript ?? (() => "final text"))(s);
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", transcript }));
      }
    });
    o.onConnection?.(s, ws);
  });
  return s;
}

// ------------------------------------------------------------------------------------------------------ Kyutai

export interface KyutaiAudio { samples: number[] }
export type KyutaiMsg = { type: "Audio"; pcm: ArrayLike<number> } | { type: "Marker"; id: number } | { type: string; [k: string]: unknown };

export interface KyutaiServer extends Base {
  /** Every decoded message, in arrival order, with its arrival time. */
  messages: { at: number; msg: KyutaiMsg }[];
  /** Every sample of every `Audio` message in order, as received. */
  samples(): number[];
  /** The `Audio` messages' sample counts, in order. */
  audioSizes(): number[];
  markers(): number[];
  send(msg: Record<string, unknown>): void;
  closeConnection(): void;
}

/**
 * A `moshi-server` ASR stream. By default it sends `Ready` after `ready` ms (default 0), and echoes a `Marker` after `echoAfter`
 * further audio messages that follow it (default: at once); `echo: false` never echoes.
 */
export async function kyutaiServer(o: {
  /** Delay before `Ready`; `false` never sends it. */
  ready?: number | false;
  /** An `Error` message sent in place of `Ready`. */
  errorInsteadOfReady?: string;
  echo?: boolean | ((s: KyutaiServer, id: number) => void);
  onConnection?: (s: KyutaiServer, ws: WebSocket) => void;
} = {}): Promise<KyutaiServer> {
  const b = await listen();
  const messages: KyutaiServer["messages"] = [];
  const s: KyutaiServer = {
    ...b, close: closer(b), messages,
    samples: () => messages.flatMap((m) => (m.msg.type === "Audio" ? Array.from((m.msg as { pcm: ArrayLike<number> }).pcm) : [])),
    audioSizes: () => messages.flatMap((m) => (m.msg.type === "Audio" ? [Array.from((m.msg as { pcm: ArrayLike<number> }).pcm).length] : [])),
    markers: () => messages.flatMap((m) => (m.msg.type === "Marker" ? [(m.msg as { id: number }).id] : [])),
    send: (msg) => b.sockets.at(-1)!.send(encode(msg)),
    closeConnection: () => b.sockets.at(-1)!.close(),
  };
  b.wss.on("connection", (ws) => {
    if (o.errorInsteadOfReady !== undefined) ws.send(encode({ type: "Error", message: o.errorInsteadOfReady }));
    else if (o.ready !== false) setTimeout(() => { if (ws.readyState === ws.OPEN) ws.send(encode({ type: "Ready" })); }, o.ready ?? 0);
    ws.on("message", (data) => {
      const msg = decode(data as Buffer) as KyutaiMsg;
      messages.push({ at: Date.now(), msg });
      if (msg.type === "Marker" && o.echo !== false) {
        const id = (msg as { id: number }).id;
        if (typeof o.echo === "function") o.echo(s, id);
        else ws.send(encode({ type: "Marker", id }));
      }
    });
    o.onConnection?.(s, ws);
  });
  return s;
}

/** A `Step` message with the four pause probabilities (0.5, 1, 2 and 3 s). */
export const step = (prs: [number, number, number, number], idx = 0) => ({ type: "Step", step_idx: idx, prs, buffered_pcm: 0 });
export const word = (text: string, start = 0) => ({ type: "Word", text, start_time: start });
