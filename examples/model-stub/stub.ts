// The smallest server cohost's OpenAI-compatible provider accepts. Node built-ins only.
//   node examples/model-stub/stub.ts [port]      (default 8901, 0 = any free port; Node 22.18 or later)
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

// #region reply
const REPLY = "[happy] Hello from the stub model server.";
// #endregion reply

const arg = process.argv[2] ?? "8901";
if (!/^\d+$/.test(arg) || Number(arg) > 65535) {
  console.error("usage: node stub.ts [port]");
  process.exit(1);
}

const send = (res: ServerResponse, status: number, body: unknown): void => {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(data) });
  res.end(data);
};

const server = createServer((req, res) => {
  req.resume(); // the request is read and ignored
  req.on("end", () => {
    // #region routes
    const path = (req.url ?? "").split("?")[0];
    if (req.method === "GET" && path === "/v1/models") {
      send(res, 200, { object: "list", data: [{ id: "stub", object: "model", owned_by: "cohost" }] });
    } else if (req.method === "POST" && path === "/v1/chat/completions") {
      send(res, 200, {
        id: "chatcmpl-stub",
        object: "chat.completion",
        created: 1700000000, // a fixed time keeps the reply the same every run
        model: "stub",
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: REPLY } }],
      });
    } else {
      send(res, 404, { error: "not found" });
    }
    // #endregion routes
  });
});

server.listen(Number(arg), "0.0.0.0", () => {
  console.log(`listening on ${(server.address() as AddressInfo).port}`);
});
