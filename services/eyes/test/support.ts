/** Shared helpers of the eyes tests: a real JPEG header and a local model server that records what the describer sends. */
import { after } from "node:test";
import http from "node:http";

/** The first bytes of a JFIF JPEG, padded: `@cohost/llm` sniffs the format and raises a TypeError for anything else (LLM-VIS-005). */
export const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01]);
export const JPEG_B64 = JPEG_BYTES.toString("base64");

export interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Record<string, any>;
}

/**
 * A local server that answers the Ollama (`/api/chat`) and OpenAI-compatible (`/chat/completions`) chat endpoints, records
 * each request and answers `state.status` (a non-200 status carries an error body) or never, while `state.hang` is set, or
 * drops the socket mid-body while `state.dropMidBody` is set.
 */
export async function serveModel(reply = "A boss appears.") {
  const seen: Seen[] = [];
  const state = { status: 200, hang: false, dropMidBody: false, reply };
  const server = http.createServer(async (req, res) => {
    let raw = ""; for await (const c of req) raw += c;
    seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: raw ? JSON.parse(raw) : {} });
    if (state.hang) return;
    if (state.dropMidBody) {
      // a reply that starts and then loses its socket: the client reads a body that ends early (a transport failure, not a status)
      res.writeHead(200, { "content-type": "application/json", "content-length": "1000" });
      res.write('{"choices":[');
      setImmediate(() => res.socket?.destroy());
      return;
    }
    res.statusCode = state.status;
    res.setHeader("content-type", "application/json");
    if (state.status !== 200) { res.end(JSON.stringify({ error: `status ${state.status}` })); return; }
    res.end(JSON.stringify(req.url?.endsWith("/api/chat")
      ? { message: { role: "assistant", content: state.reply }, done_reason: "stop" }
      : { choices: [{ message: { role: "assistant", content: state.reply }, finish_reason: "stop" }] }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  after(() => { server.closeAllConnections(); server.close(); });
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen, state };
}
