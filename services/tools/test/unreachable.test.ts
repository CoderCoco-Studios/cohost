import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { on } from "./helpers.js";
import { everythingOut, lastHealth, startMcp, waitServer } from "./mcp-helpers.js";

// A server whose URL names a host that does not resolve, or that nothing listens at, is `down` like any unreachable server
// (TOOL-SVC-011): on the redis-only network a name such as `postgres` or `ollama` does not resolve at all. What the owner and the
// model see is a sentence the service wrote, never a resolver or socket error.

const LEAKS = /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|getaddrinfo|fetch failed/i;

/** A free loopback port that nothing listens on. */
async function closedPort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as { port: number }).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

// @spec TOOL-SVC-011
test("an MCP server at a host that does not resolve is down, with the service's own sentence and no resolver text anywhere", async () => {
  const s = await startMcp({ servers: { gone: { url: "http://postgres.invalid:5432/mcp" } }, allow: { gone__web: on("web") } });
  await waitServer(s, "gone", "down");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(lastHealth(s).deps["mcp.gone"], "down");
  assert.match(lastHealth(s).detail, /gone down/);
  assert.doesNotMatch(everythingOut(s), LEAKS);
  await s.stop();
});

// @spec TOOL-SVC-011
test("an MCP server at a reachable host with nothing listening is down the same way, naming no socket error", async () => {
  const port = await closedPort();
  const s = await startMcp({ servers: { shut: { url: `http://127.0.0.1:${port}/mcp` } }, allow: { shut__web: on("web") } });
  await waitServer(s, "shut", "down");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(lastHealth(s).deps["mcp.shut"], "down");
  assert.doesNotMatch(everythingOut(s), LEAKS);
  await s.stop();
});
