/**
 * Stand-in for Ollama's chat API, so `cortex` (and the llm-kind hooks) run
 * with no GPU and no model pulled. Replies with a canned one-liner that
 * echoes the last user line.
 *
 *   node --import tsx scripts/dev/stub-llm.ts            # listens on :11434
 *
 * Serves GET /api/tags (the readiness probe) and POST /api/chat. Embeddings
 * (/api/embed) are not stubbed: `memory` also needs Postgres, so leave it out.
 */
import http from "node:http";

const PORT = Number(process.env.STUB_LLM_PORT ?? 11434);

http.createServer((req, res) => {
  const json = (code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  if (req.method === "GET" && req.url === "/api/tags") return json(200, { models: [] });
  if (req.method === "POST" && req.url === "/api/chat") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let last = "";
      try {
        const msgs = JSON.parse(body).messages as { role: string; content: string }[];
        last = msgs.filter((m) => m.role === "user").at(-1)?.content ?? "";
      } catch { /* malformed request: answer anyway */ }
      const tail = last.trim().split("\n").at(-1)?.slice(-60) ?? "";
      console.log(`llm: ${JSON.stringify(tail)}`);
      json(200, { message: { role: "assistant", content: `Stub brain here. You said: ${tail}` } });
    });
    return;
  }
  json(404, { error: "not stubbed" });
}).listen(PORT, () => console.log(`stub llm on :${PORT}`));
