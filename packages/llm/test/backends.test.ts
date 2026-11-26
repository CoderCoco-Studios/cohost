/**
 * Wire-level tests for the model backends: the Claude and Bedrock providers run through the real SDK clients against
 * a local server that replays recorded responses (test/fixtures), so no test reaches the network. Also the
 * request-shape specs that need an exact body (Ollama chat, JSON mode, `max_tokens`).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ConfigSchema } from "@cohost/config";
import { Context } from "@cohost/working-memory";
import {
  AnthropicProvider, BedrockProvider, ChatError, MockProvider, Ollama, OpenAICompatible, TRANSCRIPT_STOPS, createChatProvider,
} from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string => readFileSync(path.join(here, "fixtures", name), "utf8");
const llmCfg = (over: Record<string, unknown> = {}) =>
  ConfigSchema.shape.llm.parse({ provider: "openai", model: "m", embed_model: "e", ...over });
const user = (content: string) => [{ role: "user" as const, content }];

interface Seen { method?: string; url?: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> }
interface Reply { status?: number; file: string }

/** A server that records each request and answers from a queue of fixture files. */
async function replay(replies: Reply[]): Promise<{ base: string; seen: Seen[]; urls: string[]; fetch: typeof fetch; close: () => void }> {
  const seen: Seen[] = [];
  const urls: string[] = [];
  const server = http.createServer(async (req, res) => {
    let raw = ""; for await (const c of req) raw += c;
    seen.push({ method: req.method, url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : {} });
    const next = replies.shift();
    res.statusCode = next?.status ?? 200;
    res.setHeader("content-type", "application/json");
    res.end(next ? fixture(next.file) : "{}");
  });
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  // The providers' `deps.fetch`: records the URL the SDK chose and serves it from the local server, so a test sees where a request
  // would have gone without any network.
  const replayFetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url);
    urls.push(u.href);
    return fetch(`${base}${u.pathname}${u.search}`, init);
  }) as typeof fetch;
  return { base, seen, urls, fetch: replayFetch, close: () => server.close() };
}

/** Set environment variables for one test and restore them afterwards. */
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const old: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) { old[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

// ---- Claude API, recorded fixtures

// @spec LLM-CLAUDE-011, LLM-CLAUDE-004, LLM-CLAUDE-005, LLM-CLAUDE-007, LLM-CLAUDE-003, LLM-IF-004
test("claude api: a recorded reply is parsed and the request carries effort, betas, fallbacks and no temperature", async () => {
  const srv = await replay([{ file: "anthropic-message.json" }]);
  try {
    await withEnv({}, async () => {
      const p = new AnthropicProvider(llmCfg({ provider: "anthropic", model: "claude-fixture", claude: { api_key: "sk-fixture" } }), { fetch: srv.fetch });
      const out = await p.chat([{ role: "system", content: "persona" }, ...user("hi")], { maxTokens: 90 });
      assert.equal(out, "[happy] Hello chat! Welcome in.");
    });
    const req = srv.seen[0]!;
    assert.equal(req.method, "POST");
    assert.match(req.url!, /^\/v1\/messages/);
    assert.equal(req.headers.authorization, "Bearer sk-fixture");
    assert.match(String(req.headers["anthropic-beta"]), /server-side-fallback-2026-07-01/);
    assert.equal(req.body.model, "claude-fixture");
    assert.equal(req.body.max_tokens, 90); // @spec LLM-CLAUDE-003: the hook's budget is honoured
    assert.equal(req.body.system, "persona");
    assert.deepEqual(req.body.output_config, { effort: "low" });
    assert.equal(req.body.fallbacks, "default");
    assert.equal("temperature" in req.body, false);
    assert.deepEqual(req.body.stop_sequences, ["\n[chat]", "\n[voice]", "\n[screen]"]);
  } finally { srv.close(); }
});

// @spec LLM-CLAUDE-007
test("claude api: with fallbacks off the request carries neither betas nor fallbacks", async () => {
  const srv = await replay([{ file: "anthropic-message.json" }]);
  try {
    await withEnv({}, async () => {
      const p = new AnthropicProvider(llmCfg({ provider: "anthropic", model: "claude-fixture", claude: { api_key: "k", fallbacks: false } }), { fetch: srv.fetch });
      await p.chat(user("hi"));
    });
    const req = srv.seen[0]!;
    assert.equal("fallbacks" in req.body, false);
    assert.equal("betas" in req.body, false);
    assert.doesNotMatch(String(req.headers["anthropic-beta"] ?? ""), /server-side-fallback/);
  } finally { srv.close(); }
});

// @spec LLM-CLAUDE-003
test("claude: with no maxTokens from the caller, max_tokens is llm.claude.max_tokens", async () => {
  const srv = await replay([{ file: "anthropic-message.json" }, { file: "anthropic-message.json" }]);
  try {
    await withEnv({}, async () => {
      const p = new AnthropicProvider(llmCfg({ provider: "anthropic", model: "claude-fixture", claude: { api_key: "k", max_tokens: 1536 } }), { fetch: srv.fetch });
      await p.chat(user("hi"));
      await p.chat(user("hi"), { maxTokens: 0 }); // below the API minimum of 1: raised to it
    });
    assert.deepEqual(srv.seen.map((s) => s.body.max_tokens), [1536, 1]);
  } finally { srv.close(); }
});

// @spec LLM-CLAUDE-011, LLM-CLAUDE-006
test("claude api: a recorded refusal gives an empty reply", async () => {
  const srv = await replay([{ file: "anthropic-refusal.json" }]);
  try {
    const p = new AnthropicProvider(llmCfg({ provider: "anthropic", model: "claude-fixture", claude: { api_key: "k" } }), { fetch: srv.fetch });
    assert.equal(await p.chat(user("hi")), "");
  } finally { srv.close(); }
});

const AMBIENT_CLAUDE = {
  ANTHROPIC_API_KEY: "sk-from-env", ANTHROPIC_AUTH_TOKEN: "token-from-env", ANTHROPIC_BASE_URL: "http://127.0.0.1:9/evil",
  ANTHROPIC_PROFILE: "ambient-profile", ANTHROPIC_CUSTOM_HEADERS: "x-api-key: header-from-env",
};

// @spec LLM-CLAUDE-009
test("claude api: the configured key and the API's own base URL win over ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL and friends", async () => {
  const srv = await replay([{ file: "anthropic-message.json" }, { file: "anthropic-model.json" }]);
  try {
    await withEnv(AMBIENT_CLAUDE, async () => {
      const p = new AnthropicProvider(llmCfg({ provider: "anthropic", model: "claude-fixture", claude: { api_key: "sk-config" } }), { fetch: srv.fetch });
      assert.match(await p.chat(user("hi")), /Hello chat/);
      assert.equal(await p.ping(), true);
    });
    assert.equal(srv.urls.length, 2);
    for (const u of srv.urls) assert.equal(new URL(u).origin, "https://api.anthropic.com");
    for (const r of srv.seen) {
      assert.equal(r.headers.authorization, "Bearer sk-config");
      assert.equal(r.headers["x-api-key"], undefined, "a credential header from ANTHROPIC_CUSTOM_HEADERS is not sent");
    }
  } finally { srv.close(); }
});

// @spec LLM-CLAUDE-017
test("claude api: with no key configured there is no client, whatever ANTHROPIC_API_KEY holds: chat rejects and ping is false, both naming llm.claude.api_key, and nothing is sent", async () => {
  const srv = await replay([{ file: "anthropic-message.json" }]);
  try {
    await withEnv(AMBIENT_CLAUDE, async () => {
      const p = new AnthropicProvider(llmCfg({ provider: "anthropic", model: "claude-fixture", claude: { api_key: "" } }), { fetch: srv.fetch });
      await assert.rejects(p.chat(user("hi")), /llm\.claude\.api_key/);
      assert.equal(await p.ping(), false);
      assert.match(p.lastError!, /llm\.claude\.api_key/);
    });
    assert.equal(srv.seen.length, 0);
  } finally { srv.close(); }
});

// @spec LLM-CLAUDE-011, LLM-PING-003, LLM-PING-005
test("claude api: ping against recorded model, 401 and 404 answers", async () => {
  const srv = await replay([
    { file: "anthropic-error-401.json", status: 401 },
    { file: "anthropic-error-404.json", status: 404 },
    { file: "anthropic-model.json" },
  ]);
  try {
    await withEnv({}, async () => {
      const p = new AnthropicProvider(llmCfg({ provider: "anthropic", model: "claude-fixture", claude: { api_key: "bad" } }), { fetch: srv.fetch });
      assert.equal(await p.ping(), false);
      assert.match(p.lastError!, /credentials \(401\)/);
      assert.equal(await p.ping(), false);
      assert.match(p.lastError!, /no model "claude-fixture"/);
      assert.equal(await p.ping(), true);
      assert.equal(p.lastError, undefined);
    });
    assert.match(srv.seen[0]!.url!, /^\/v1\/models\/claude-fixture/);
  } finally { srv.close(); }
});

// ---- Bedrock, recorded fixtures

const bedrockCfg = (bedrock: Record<string, unknown>) => llmCfg({ provider: "bedrock", model: "anthropic.claude-fixture", bedrock });
const CONFIGURED = { region: "eu-west-2", access_key_id: "AKIACONFIG", secret_access_key: "config-secret" };

// @spec LLM-CLAUDE-012, LLM-CLAUDE-008, LLM-PING-004, LLM-PING-006
test("bedrock: a recorded reply is parsed; no betas or fallbacks are sent; the request is SigV4-signed with the configured credentials", async () => {
  const srv = await replay([{ file: "bedrock-message.json" }]);
  try {
    const b = new BedrockProvider(bedrockCfg(CONFIGURED), { fetch: srv.fetch });
    assert.equal(await b.chat(user("hi"), { maxTokens: 70 }), "[smug] From Bedrock, with love.");
    assert.equal(await b.ping(), true);
    assert.equal(b.pingIsNominal, true);
    assert.equal(srv.seen.length, 1, "ping makes no request");
    const req = srv.seen[0]!;
    assert.match(req.url!, /messages/);
    assert.equal(req.body.max_tokens, 70);
    assert.equal(req.body.model, "anthropic.claude-fixture");
    assert.equal("fallbacks" in req.body, false);
    assert.equal("betas" in req.body, false);
    assert.doesNotMatch(String(req.headers["anthropic-beta"] ?? ""), /server-side-fallback/);
    assert.match(String(req.headers.authorization), /AWS4-HMAC-SHA256/);
  } finally { srv.close(); }
});

// @spec LLM-CLAUDE-015
test("bedrock: the configured region and keys sign the request, whatever AWS_* and the Bedrock variables hold", async () => {
  const srv = await replay([{ file: "bedrock-message.json" }]);
  try {
    await withEnv({
      AWS_ACCESS_KEY_ID: "AKIAAMBIENT", AWS_SECRET_ACCESS_KEY: "ambient-secret", AWS_SESSION_TOKEN: "ambient-session",
      AWS_PROFILE: "ambient-profile", AWS_REGION: "us-east-1", AWS_DEFAULT_REGION: "us-east-2",
      AWS_BEARER_TOKEN_BEDROCK: "ambient-bearer", ANTHROPIC_BEDROCK_MANTLE_BASE_URL: "http://127.0.0.1:9/evil",
    }, async () => {
      const b = new BedrockProvider(bedrockCfg(CONFIGURED), { fetch: srv.fetch });
      assert.equal(await b.chat(user("hi")), "[smug] From Bedrock, with love.");
    });
    assert.equal(new URL(srv.urls[0]!).origin, "https://bedrock-mantle.eu-west-2.api.aws");
    const req = srv.seen[0]!;
    const auth = String(req.headers.authorization);
    assert.match(auth, /^AWS4-HMAC-SHA256 Credential=AKIACONFIG\/\d{8}\/eu-west-2\/bedrock-mantle\/aws4_request/);
    assert.equal(req.headers["x-amz-security-token"], undefined, "no session token is sent");
    assert.doesNotMatch(auth, /ambient|Bearer/i);
  } finally { srv.close(); }
});

// @spec LLM-CLAUDE-016
test("bedrock: exactly one of the two keys set refuses to construct, naming both keys, whatever the environment holds", async () => {
  await withEnv({ AWS_ACCESS_KEY_ID: "AKIAAMBIENT", AWS_SECRET_ACCESS_KEY: "ambient-secret" }, async () => {
    for (const half of [{ access_key_id: "AKIACONFIG" }, { secret_access_key: "config-secret" }]) {
      assert.throws(() => new BedrockProvider(bedrockCfg({ region: "eu-west-2", ...half })), (e: Error) =>
        /llm\.bedrock\.access_key_id/.test(e.message) && /llm\.bedrock\.secret_access_key/.test(e.message));
    }
  });
});

// @spec LLM-CLAUDE-018
test("bedrock: an empty key pair or region builds no client, whatever the environment holds: chat rejects naming each empty key, ping stays nominal, nothing is sent", async () => {
  const srv = await replay([{ file: "bedrock-message.json" }]);
  try {
    await withEnv({
      AWS_ACCESS_KEY_ID: "AKIAAMBIENT", AWS_SECRET_ACCESS_KEY: "ambient-secret", AWS_REGION: "us-east-1", AWS_PROFILE: "p",
    }, async () => {
      const cases: [Record<string, unknown>, string[]][] = [
        [{}, ["region", "access_key_id", "secret_access_key"]],
        [{ region: "eu-west-2" }, ["access_key_id", "secret_access_key"]],
        [{ access_key_id: "AKIACONFIG", secret_access_key: "s" }, ["region"]],
      ];
      for (const [bedrock, empty] of cases) {
        const b = new BedrockProvider(bedrockCfg(bedrock), { fetch: srv.fetch });
        await assert.rejects(b.chat(user("hi")), (e: Error) => empty.every((k) => e.message.includes(`llm.bedrock.${k}`)) &&
          ["region", "access_key_id", "secret_access_key"].filter((k) => !empty.includes(k)).every((k) => !e.message.includes(`llm.bedrock.${k}`)));
        assert.equal(await b.ping(), true);
        assert.equal(b.pingIsNominal, true);
      }
    });
    assert.equal(srv.seen.length, 0);
  } finally { srv.close(); }
});

// ---- No environment variable reaches a client (LLM-CLAUDE-019)

const INJECTED_HEADERS = "Authorization: Bearer sk-FROM-ENV\nanthropic-beta: evil\nx-api-key: key-FROM-ENV";

/** Variables the SDKs read that are not credential, endpoint, header or behaviour switches: the home and platform lookups of the default credential chain and the profile files, which an explicit credential never reaches. */
const SDK_NON_SETTING_VARS = new Set(["HOME", "USERPROFILE", "APPDATA", "XDG_CONFIG_HOME", "HOSTNAME", "PATH"]);

/** A hostile value for every variable either SDK reads; a scanned name missing from this table turns the guard test red. */
const HOSTILE_SDK_ENV: Record<string, string> = {
  ANTHROPIC_API_KEY: "sk-from-env", ANTHROPIC_AUTH_TOKEN: "token-from-env", ANTHROPIC_BASE_URL: "http://127.0.0.1:9/evil",
  ANTHROPIC_BEDROCK_BASE_URL: "http://127.0.0.1:9/evil", ANTHROPIC_BEDROCK_MANTLE_BASE_URL: "http://127.0.0.1:9/evil",
  ANTHROPIC_CONFIG_DIR: "/nonexistent-evil", ANTHROPIC_CUSTOM_HEADERS: INJECTED_HEADERS,
  ANTHROPIC_ENVIRONMENT_ID: "evil", ANTHROPIC_ENVIRONMENT_KEY: "evil", ANTHROPIC_FEDERATION_RULE_ID: "evil",
  ANTHROPIC_IDENTITY_TOKEN: "evil", ANTHROPIC_IDENTITY_TOKEN_FILE: "/nonexistent-evil", ANTHROPIC_LOG: "debug",
  ANTHROPIC_OPEN_TELEMETRY: "true", ANTHROPIC_OPEN_TELEMETRY_PROPAGATION: "true",
  ANTHROPIC_OPEN_TELEMETRY_TRACES_CONTENT_MODE: "content", ANTHROPIC_OPEN_TELEMETRY_TRACES_MAX_CONTENT_BYTES: "1",
  ANTHROPIC_ORGANIZATION_ID: "evil", ANTHROPIC_PROFILE: "ambient-profile", ANTHROPIC_SCOPE: "evil",
  ANTHROPIC_SERVICE_ACCOUNT_ID: "evil", ANTHROPIC_SESSION_ID: "evil", ANTHROPIC_WEBHOOK_SIGNING_KEY: "evil",
  ANTHROPIC_WORKSPACE_ID: "evil", ANTHROPIC_WORK_ID: "evil", ANTHROPIC_WORK_SECRET: "evil",
  AWS_ACCESS_KEY_ID: "AKIAAMBIENT", AWS_SECRET_ACCESS_KEY: "ambient-secret", AWS_SESSION_TOKEN: "ambient-session",
  AWS_PROFILE: "ambient-profile", AWS_REGION: "us-east-1", AWS_DEFAULT_REGION: "us-east-2",
  AWS_BEARER_TOKEN_BEDROCK: "ambient-bearer",
};

/** Every environment variable name the installed SDK sources read. */
function scanSdkEnvNames(): string[] {
  const roots = ["@anthropic-ai/sdk", "@anthropic-ai/bedrock-sdk"].map((n) => realpathSync(path.join(here, "..", "node_modules", n)));
  const names = new Set<string>();
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== "node_modules" && e.name !== "src") walk(full); continue; }
      if (!e.name.endsWith(".mjs")) continue;
      const text = readFileSync(full, "utf8");
      for (const m of text.matchAll(/readEnv\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g)) names.add(m[1]!);
      for (const m of text.matchAll(/process\.env\??\.\[?['"]?([A-Z][A-Z0-9_]*)['"]?\]?/g)) names.add(m[1]!);
      for (const m of text.matchAll(/env\??\.?\[['"]([A-Z][A-Z0-9_]*)['"]\]/g)) names.add(m[1]!);
      for (const m of text.matchAll(/['"]((?:ANTHROPIC|AWS)_[A-Z0-9_]+)['"]/g)) names.add(m[1]!);
    }
  };
  for (const r of roots) walk(r);
  return [...names].toSorted();
}

// @spec LLM-CLAUDE-019
test("sdk environment guard: every variable the installed SDKs read has a hostile value in the ambient-credential tests", () => {
  const scanned = scanSdkEnvNames().filter((n) => !SDK_NON_SETTING_VARS.has(n));
  assert.ok(scanned.includes("ANTHROPIC_CUSTOM_HEADERS") && scanned.includes("AWS_BEARER_TOKEN_BEDROCK"), "the scan finds the known variables");
  const missing = scanned.filter((n) => !(n in HOSTILE_SDK_ENV));
  assert.deepEqual(missing, [], `the SDK reads these variables; give each a hostile value in HOSTILE_SDK_ENV and confirm the provider ignores it: ${missing.join(", ")}`);
});

// @spec LLM-CLAUDE-019
test("claude api: no environment variable changes the credential, endpoint or any request header (ANTHROPIC_CUSTOM_HEADERS with Authorization and anthropic-beta included)", async () => {
  const srv = await replay([{ file: "anthropic-message.json" }, { file: "anthropic-model.json" }]);
  try {
    await withEnv(HOSTILE_SDK_ENV, async () => {
      const p = new AnthropicProvider(llmCfg({ provider: "anthropic", model: "claude-fixture", claude: { api_key: "sk-config" } }), { fetch: srv.fetch });
      assert.match(await p.chat(user("hi")), /Hello chat/);
      assert.equal(await p.ping(), true);
    });
    assert.equal(srv.seen.length, 2);
    for (const u of srv.urls) assert.equal(new URL(u).origin, "https://api.anthropic.com");
    for (const r of srv.seen) {
      assert.equal(r.headers.authorization, "Bearer sk-config");
      assert.equal(r.headers["x-api-key"], undefined);
      assert.doesNotMatch(String(r.headers["anthropic-beta"] ?? ""), /evil/);
    }
    assert.equal(srv.seen[0]!.headers["anthropic-beta"], "server-side-fallback-2026-07-01", "the betas the call asked for are untouched");
  } finally { srv.close(); }
});

// @spec LLM-CLAUDE-019
test("claude api: a variable set after the client is built changes nothing either", async () => {
  const srv = await replay([{ file: "anthropic-message.json" }]);
  try {
    const p = new AnthropicProvider(llmCfg({ provider: "anthropic", model: "claude-fixture", claude: { api_key: "sk-config" } }), { fetch: srv.fetch });
    await withEnv(HOSTILE_SDK_ENV, async () => { await p.chat(user("hi")); });
    assert.equal(srv.seen[0]!.headers.authorization, "Bearer sk-config");
    assert.doesNotMatch(String(srv.seen[0]!.headers["anthropic-beta"] ?? ""), /evil/);
  } finally { srv.close(); }
});

// @spec LLM-CLAUDE-019
test("bedrock: no environment variable changes the signing credential, region, endpoint or any request header (ANTHROPIC_CUSTOM_HEADERS included)", async () => {
  const srv = await replay([{ file: "bedrock-message.json" }]);
  try {
    await withEnv(HOSTILE_SDK_ENV, async () => {
      const b = new BedrockProvider(bedrockCfg(CONFIGURED), { fetch: srv.fetch });
      assert.equal(await b.chat(user("hi")), "[smug] From Bedrock, with love.");
    });
    assert.equal(new URL(srv.urls[0]!).origin, "https://bedrock-mantle.eu-west-2.api.aws");
    const h = srv.seen[0]!.headers;
    assert.match(String(h.authorization), /^AWS4-HMAC-SHA256 Credential=AKIACONFIG\//);
    assert.doesNotMatch(String(h.authorization), /FROM-ENV|ambient/);
    assert.equal(h["anthropic-beta"], undefined, "no injected anthropic-beta");
    assert.equal(h["x-api-key"], undefined);
    assert.equal(h["x-amz-security-token"], undefined);
  } finally { srv.close(); }
});

// ---- opt-in live smoke

// @spec LLM-CLAUDE-013
test("claude api live smoke (set ANTHROPIC_API_KEY and COHOST_LIVE_CLAUDE_MODEL to run)", { skip: !process.env.ANTHROPIC_API_KEY || !process.env.COHOST_LIVE_CLAUDE_MODEL }, async () => {
  const p = new AnthropicProvider(llmCfg({ provider: "anthropic", model: process.env.COHOST_LIVE_CLAUDE_MODEL, claude: { api_key: "" } }));
  assert.equal(await p.ping(), true, p.lastError ?? "no lastError");
  const out = await p.chat(user("Reply with the single word: ok"), { maxTokens: 512 });
  assert.ok(out.length > 0);
});

// ---- Ollama and OpenAI request bodies

async function bodyServer(): Promise<{ base: string; bodies: Record<string, unknown>[]; reply: { json: unknown; status: number }; close: () => void }> {
  const bodies: Record<string, unknown>[] = [];
  const reply = { json: {} as unknown, status: 200 };
  const server = http.createServer(async (req, res) => {
    let raw = ""; for await (const c of req) raw += c;
    if (raw) bodies.push(JSON.parse(raw));
    res.statusCode = reply.status;
    res.end(JSON.stringify(reply.json));
  });
  await new Promise<void>((r) => server.listen(0, r));
  return { base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, bodies, reply, close: () => server.close() };
}

// @spec LLM-CHAT-001, LLM-STOP-001, LLM-CHAT-007
test("ollama chat: the exact request body, the exact stop list, and an empty reply is an empty string", async () => {
  const s = await bodyServer();
  try {
    s.reply.json = { message: { content: "  hello  " } };
    const o = new Ollama(llmCfg({ provider: "ollama", model: "qwen", temperature: 0.7, max_tokens: 90, num_ctx: 4096 }), s.base);
    assert.equal(await o.chat(user("hi")), "hello");
    assert.deepEqual(s.bodies[0], {
      model: "qwen",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
      keep_alive: "24h",
      options: { temperature: 0.7, num_ctx: 4096, num_predict: 90, stop: ["\n\n", "\n[chat]", "\n[voice]", "\n[screen]"] },
    });
    s.reply.json = {};
    assert.equal(await o.chat(user("hi")), "");
    s.reply.json = { message: {} };
    assert.equal(await o.chat(user("hi")), "");
  } finally { s.close(); }
});

// @spec LLM-CHAT-007
test("openai-compatible: a reply with no content (missing or null) is an empty string", async () => {
  const s = await bodyServer();
  try {
    const p = new OpenAICompatible(llmCfg({ openai: { base_url: `${s.base}/v1` } }));
    s.reply.json = { choices: [] };
    assert.equal(await p.chat(user("hi")), "");
    s.reply.json = { choices: [{ message: { content: null } }] };
    assert.equal(await p.chat(user("hi")), "");
  } finally { s.close(); }
});

// @spec LLM-PING-001
test("ollama ping: a 2xx answer from /api/tags is true and clears lastError", async () => {
  const s = await bodyServer();
  try {
    const o = new Ollama(llmCfg({ provider: "ollama" }), s.base);
    s.reply.status = 500;
    assert.equal(await o.ping(), false);
    assert.match(o.lastError!, /ollama 500/);
    s.reply.status = 200;
    assert.equal(await o.ping(), true);
    assert.equal(o.lastError, undefined);
  } finally { s.close(); }
});

// @spec LLM-CHAT-010
test("json mode asks Ollama for format json and OpenAI-compatible servers for a json_object response; other calls ask for neither", async () => {
  const s = await bodyServer();
  try {
    s.reply.json = { message: { content: "{}" }, choices: [{ message: { content: "{}" } }] };
    const o = new Ollama(llmCfg({ provider: "ollama" }), s.base);
    const p = new OpenAICompatible(llmCfg({ openai: { base_url: `${s.base}/v1` } }));
    await o.chat(user("hi"), { json: true });
    await p.chat(user("hi"), { json: true });
    await o.chat(user("hi"));
    await p.chat(user("hi"));
    assert.equal(s.bodies[0]!.format, "json");
    assert.deepEqual(s.bodies[1]!.response_format, { type: "json_object" });
    assert.equal("format" in s.bodies[2]!, false);
    assert.equal("response_format" in s.bodies[3]!, false);
  } finally { s.close(); }
});

// ---- mock

// @spec LLM-MOCK-001
test("mock provider: the reply text is cut at 80 characters and an empty user message says hello", async () => {
  const p = new MockProvider({ model: "m" });
  assert.equal(await p.chat(user("x".repeat(200))), `[happy] mock: ${"x".repeat(80)}`);
  assert.equal(await p.chat(user("   \n  ")), "[happy] mock: hello");
  assert.equal(await p.chat([{ role: "system", content: "s" }]), "[happy] mock: hello");
  assert.ok(createChatProvider(llmCfg({ provider: "mock" })) instanceof MockProvider);
});

// ---- cross-package

// @spec LLM-STOP-006
test("every tag working-memory renders at the start of a chat, voice or screen line has a matching transcript stop", () => {
  const ctx = new Context(10);
  const ev = (type: string, data: Record<string, unknown>, ts: number) => ({ id: String(ts), type, ts, source: "t", data }) as unknown as Parameters<Context["push"]>[0];
  ctx.push(ev("chat.message", { platform: "twitch", user: "viewer", text: "hello", isMod: false, isSub: false, mentionsCohost: false }, 1));
  ctx.push(ev("speech.heard", { speaker: "Streamer", text: "hi chat", durationMs: 500 }, 2));
  ctx.push(ev("vision.summary", { text: "a menu", changed: true }, 3));
  ctx.pushSelf("welcome", "happy", 4);
  const lines = ctx.transcript("Coco").split("\n");
  const tags = lines.map((l) => /^\[[a-z]+\]/.exec(l)?.[0]);
  assert.equal(lines.length, 4);
  assert.equal(tags[3], undefined, "the co-host's own line carries no tag");
  tags.length = 3;
  assert.ok(tags.every((t) => t !== undefined));
  assert.deepEqual(TRANSCRIPT_STOPS, tags.map((t) => `\n${t}`));
  assert.equal(TRANSCRIPT_STOPS.some((s) => s.startsWith("\nCoco")), false, "the co-host's own line is not a stop");
});

// ---- complete() and stream() on the Claude API and Bedrock (issue #161)
// `complete()` and `stream()` do not exist on the Claude providers yet, so they are called through `any`.

type Ctx = { req: http.IncomingMessage; res: http.ServerResponse; n: number; body: Record<string, any> };
/** A backend that scripts each response by hand; `fetch` is the Claude providers' `deps.fetch`, serving the SDK's URL from it. */
async function claudeBackend(script: (c: Ctx) => void | Promise<void>) {
  const seen: Seen[] = [];
  const server = http.createServer(async (req, res) => {
    let raw = ""; for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};
    seen.push({ method: req.method, url: req.url, headers: req.headers, body });
    await script({ req, res, n: seen.length, body });
  });
  await new Promise<void>((r) => server.listen(0, r));
  after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const urls: string[] = [];
  const claudeFetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url);
    urls.push(u.href);
    return fetch(`${base}${u.pathname}${u.search}`, init);
  }) as typeof fetch;
  return { base, seen, urls, fetch: claudeFetch };
}
const sendJson = (res: http.ServerResponse, file: string, status = 200, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(fixture(file));
};
const sendSse = (res: http.ServerResponse, text: string) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.end(text); };
const sseEvent = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** The `message_start` event of the plain recorded stream: a reply that has begun. */
const sseStart = fixture("anthropic-stream-plain.sse").split("\n\n")[0]! + "\n\n";
/** Makes the SDK's retry back off for 1 ms instead of a second. */
const noRetryWait = { "retry-after-ms": "1" };

type ClaudeKind = "anthropic" | "bedrock";
const claudeKinds: ClaudeKind[] = ["anthropic", "bedrock"];
const MESSAGE: Record<ClaudeKind, string> = { anthropic: "anthropic-message.json", bedrock: "bedrock-message.json" };
const STREAM: Record<ClaudeKind, string> = { anthropic: "anthropic-stream-plain.sse", bedrock: "bedrock-stream-plain.sse" };
const TEXT: Record<ClaudeKind, string> = { anthropic: "[happy] Hello chat! Welcome in.", bedrock: "[smug] From Bedrock, with love." };
const STREAMED_TEXT: Record<ClaudeKind, string> = { anthropic: "[happy] Hello chat!", bedrock: "[smug] From Bedrock, with love." };
const claude = (kind: ClaudeKind, fetchImpl: typeof fetch | undefined, over: Record<string, unknown> = {}, claudeOver: Record<string, unknown> = {}): any =>
  kind === "anthropic"
    ? new AnthropicProvider(llmCfg({ provider: "anthropic", model: "claude-fixture", claude: { api_key: "sk-config", ...claudeOver }, ...over }), fetchImpl ? { fetch: fetchImpl } : {})
    : new BedrockProvider(llmCfg({ provider: "bedrock", model: "anthropic.claude-fixture", bedrock: CONFIGURED, claude: claudeOver, ...over }), fetchImpl ? { fetch: fetchImpl } : {});
/** The reply a backend gives to `call`: a JSON message for `complete`, a stream for `stream`. */
const answer = (kind: ClaudeKind, call: "complete" | "stream", res: http.ServerResponse) =>
  call === "complete" ? sendJson(res, MESSAGE[kind]) : sendSse(res, fixture(STREAM[kind]));
const calls = ["complete", "stream"] as const;
async function collect(it: AsyncIterable<any>): Promise<any[]> { const out: any[] = []; for await (const e of it) out.push(e); return out; }
const failure = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } };
const textOf = (evs: any[]) => evs.filter((e) => e.type === "text").map((e) => e.delta).join("");

/** Runs one call and returns the request it sent. */
async function request(kind: ClaudeKind, call: "complete" | "stream", messages: any[], opts: Record<string, unknown> = {}, claudeOver: Record<string, unknown> = {}) {
  const b = await claudeBackend(({ res }) => answer(kind, call, res));
  const p = claude(kind, b.fetch, {}, claudeOver);
  if (call === "complete") await p.complete(messages, opts); else await collect(p.stream(messages, opts));
  return b.seen[0]!;
}

// @spec LLM-IF-005, LLM-IF-006, LLM-IF-007, LLM-IF-015, LLM-CLAUDE-031, LLM-STREAM-013
test("claude and bedrock: complete() sends a non-streamed request and resolves to a ChatResult: text from the text blocks joined with no separator and trimmed, thinking dropped, an assistant message mirroring it", async () => {
  for (const kind of claudeKinds) {
    const b = await claudeBackend(({ res }) => sendJson(res, MESSAGE[kind]));
    const r = await claude(kind, b.fetch).complete(user("hi"));
    assert.equal(r.text, TEXT[kind], kind);
    assert.doesNotMatch(r.text, /viewer greeted|short line/, "thinking is not text");
    assert.deepEqual(r.toolCalls, []);
    assert.equal(r.finish, "stop");
    assert.equal(r.message.role, "assistant");
    assert.equal(r.message.content, r.text);
    assert.equal("toolCalls" in r.message, false);
    assert.notEqual(b.seen[0]!.body.stream, true, "a non-streamed request");
  }
});

// @spec LLM-IF-005, LLM-IF-006, LLM-IF-007, LLM-IF-015
test("mock: complete() resolves to a ChatResult with the chat() text, finish stop and an assistant message mirroring it", async () => {
  const p = new MockProvider({ model: "m" }) as any;
  const r = await p.complete(user("hello there"));
  assert.equal(r.text, await p.chat(user("hello there")));
  assert.equal(r.finish, "stop");
  assert.deepEqual(r.toolCalls, []);
  assert.deepEqual(r.message, { role: "assistant", content: r.text });
});

// @spec LLM-IF-020
test("every provider exposes complete() and stream() beside chat()", () => {
  const providers = [
    createChatProvider(llmCfg({ provider: "ollama" })),
    createChatProvider(llmCfg({ provider: "openai" })),
    createChatProvider(llmCfg({ provider: "anthropic", claude: { api_key: "k" } })),
    createChatProvider(llmCfg({ provider: "bedrock", bedrock: CONFIGURED })),
    createChatProvider(llmCfg({ provider: "mock" })),
  ] as any[];
  assert.deepEqual(providers.map((p) => p.name), ["ollama", "openai", "anthropic", "bedrock", "mock"]);
  for (const p of providers) {
    for (const fn of ["chat", "complete", "stream"]) assert.equal(typeof p[fn], "function", `${p.name}.${fn}`);
  }
});

// @spec LLM-IF-014, LLM-IF-015
test("claude: complete() maps stop_reason max_tokens to finish length and end_turn, stop_sequence to stop", async () => {
  for (const kind of claudeKinds) {
    for (const [reason, want] of [["max_tokens", "length"], ["end_turn", "stop"], ["stop_sequence", "stop"]] as const) {
      const msg = { ...JSON.parse(fixture(MESSAGE[kind])), stop_reason: reason };
      const b = await claudeBackend(({ res }) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(msg)); });
      assert.equal((await claude(kind, b.fetch).complete(user("hi"))).finish, want, `${kind} ${reason}`);
    }
  }
});

// @spec LLM-STREAM-031, LLM-IF-014, LLM-IF-015
test("claude: stream() takes the finish reason from the stop_reason of the final message delta", async () => {
  for (const kind of claudeKinds) {
    for (const [reason, want] of [["max_tokens", "length"], ["end_turn", "stop"], ["stop_sequence", "stop"], ["refusal", "refusal"]] as const) {
      const body = fixture(STREAM[kind]).replace('"stop_reason": "end_turn"', `"stop_reason": "${reason}"`);
      const b = await claudeBackend(({ res }) => sendSse(res, body));
      const evs = await collect(claude(kind, b.fetch).stream(user("hi")));
      assert.equal(evs.at(-1).type, "done");
      assert.equal(evs.at(-1).result.finish, want, `${kind} ${reason}`);
    }
  }
});

// @spec LLM-CLAUDE-021
test("claude: a refusal makes complete() resolve with finish refusal, empty text and empty toolCalls, even when the reply held text", async () => {
  for (const kind of claudeKinds) {
    const refusal = { ...JSON.parse(fixture("anthropic-refusal.json")), content: [{ type: "text", text: "I can't help with" }] };
    const b = await claudeBackend(({ res, n }) => {
      if (n === 1) return sendJson(res, "anthropic-refusal.json");
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(refusal));
    });
    const p = claude(kind, b.fetch);
    for (const i of [0, 1]) {
      const r = await p.complete(user("hi"));
      assert.equal(r.finish, "refusal", `${kind} ${i}`);
      assert.equal(r.text, "");
      assert.deepEqual(r.toolCalls, []);
      assert.equal(r.message.content, "");
    }
  }
});

// @spec LLM-CLAUDE-023, LLM-CLAUDE-024
test("claude: complete() and stream() join system messages with a blank line into system, and omit it when there are none", async () => {
  for (const kind of claudeKinds) for (const call of calls) {
    const withSystem = await request(kind, call, [{ role: "system", content: "persona" }, { role: "system", content: "rules" }, { role: "user", content: "hi" }]);
    assert.equal(withSystem.body.system, "persona\n\nrules", `${kind} ${call}`);
    const none = await request(kind, call, user("hi"));
    assert.equal("system" in none.body, false, `${kind} ${call}`);
  }
});

// @spec LLM-CLAUDE-025, LLM-CLAUDE-026
test("claude: complete() and stream() prepend a (begin) user turn when the turns are empty or do not begin with a user turn", async () => {
  for (const kind of claudeKinds) for (const call of calls) {
    const begin = { role: "user", content: "(begin)" };
    const onlySystem = await request(kind, call, [{ role: "system", content: "s" }]);
    assert.deepEqual(onlySystem.body.messages, [begin], `${kind} ${call}`);
    const startsAssistant = await request(kind, call, [{ role: "assistant", content: "hello" }, { role: "user", content: "hi" }]);
    const sent = startsAssistant.body.messages;
    assert.ok(Array.isArray(sent), `${kind} ${call}`);
    assert.deepEqual(sent[0], begin, `${kind} ${call}`);
    assert.equal(sent.length, 3);
    const startsUser = await request(kind, call, user("hi"));
    assert.deepEqual(startsUser.body.messages, [{ role: "user", content: "hi" }]);
  }
});

// @spec LLM-CLAUDE-027, LLM-CLAUDE-028
test("claude: complete() and stream() send the caller's maxTokens raised to 1, else llm.claude.max_tokens", async () => {
  for (const kind of claudeKinds) for (const call of calls) {
    assert.equal((await request(kind, call, user("hi"), { maxTokens: 90 })).body.max_tokens, 90, `${kind} ${call}`);
    assert.equal((await request(kind, call, user("hi"), { maxTokens: 0 })).body.max_tokens, 1, `${kind} ${call}`);
    assert.equal((await request(kind, call, user("hi"), {}, { max_tokens: 1536 })).body.max_tokens, 1536, `${kind} ${call}`);
  }
});

// @spec LLM-CLAUDE-029, LLM-CLAUDE-030
test("claude: complete() and stream() send output_config.effort from llm.claude.effort and no temperature, whatever the caller asks", async () => {
  for (const kind of claudeKinds) for (const call of calls) {
    const low = await request(kind, call, user("hi"), { temperature: 0.9 });
    assert.deepEqual(low.body.output_config, { effort: "low" }, `${kind} ${call}`);
    assert.equal("temperature" in low.body, false);
    const high = await request(kind, call, user("hi"), {}, { effort: "high" });
    assert.deepEqual(high.body.output_config, { effort: "high" });
  }
});

// @spec LLM-STREAM-007
test("claude: stream() uses the SDK's streaming request", async () => {
  for (const kind of claudeKinds) {
    const r = await request(kind, "stream", user("hi"));
    assert.equal(r.method, "POST");
    assert.match(r.url!, /messages/);
    assert.equal(r.body.stream, true, kind);
  }
});

// @spec LLM-STOP-015, LLM-STOP-016
test("claude: a reply call to complete() or stream() sends TRANSCRIPT_STOPS and no blank-line stop", async () => {
  for (const kind of claudeKinds) for (const call of calls) {
    const r = await request(kind, call, user("hi"));
    assert.deepEqual(r.body.stop_sequences, ["\n[chat]", "\n[voice]", "\n[screen]"], `${kind} ${call}`);
    assert.deepEqual(r.body.stop_sequences, TRANSCRIPT_STOPS);
    assert.equal((r.body.stop_sequences as string[]).includes("\n\n"), false);
  }
});

// @spec LLM-STOP-017
test("json: true sends no stop sequences on complete() of any real provider", async () => {
  for (const kind of claudeKinds) {
    const r = await request(kind, "complete", user("hi"), { json: true });
    assert.equal("stop_sequences" in r.body, false, kind);
  }
  const reply = { message: { content: "{}" }, done_reason: "stop", choices: [{ message: { content: "{}" }, finish_reason: "stop" }] };
  const b = await claudeBackend(({ res }) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(reply)); });
  await (new Ollama(llmCfg({ provider: "ollama" }), b.base) as any).complete(user("hi"), { json: true });
  await (new OpenAICompatible(llmCfg({ openai: { base_url: `${b.base}/v1` } })) as any).complete(user("hi"), { json: true });
  assert.equal(b.seen.length, 2);
  const ollamaOptions = b.seen[0]!.body.options;
  assert.equal(typeof ollamaOptions === "object" && ollamaOptions !== null && "stop" in ollamaOptions, false, "ollama");
  assert.equal("stop" in b.seen[1]!.body, false, "openai");
});

// @spec LLM-CLAUDE-032
test("claude: complete() adds the fallback beta and fallbacks on anthropic when llm.claude.fallbacks is true, neither when false, and never on bedrock", async () => {
  const on = await request("anthropic", "complete", user("hi"));
  assert.equal(on.body.fallbacks, "default");
  assert.equal(on.headers["anthropic-beta"], "server-side-fallback-2026-07-01");
  const off = await request("anthropic", "complete", user("hi"), {}, { fallbacks: false });
  assert.equal("fallbacks" in off.body, false);
  assert.equal("betas" in off.body, false);
  assert.doesNotMatch(String(off.headers["anthropic-beta"] ?? ""), /server-side-fallback/);
  const bedrock = await request("bedrock", "complete", user("hi"));
  assert.equal("fallbacks" in bedrock.body, false);
  assert.doesNotMatch(String(bedrock.headers["anthropic-beta"] ?? ""), /server-side-fallback/);
});

// @spec LLM-CLAUDE-022
test("claude: stream() on anthropic sends neither the fallback beta nor fallbacks, with llm.claude.fallbacks true", async () => {
  const r = await request("anthropic", "stream", user("hi"), {}, { fallbacks: true });
  assert.equal("fallbacks" in r.body, false);
  assert.equal("betas" in r.body, false);
  assert.doesNotMatch(String(r.headers["anthropic-beta"] ?? ""), /server-side-fallback/);
  const bedrock = await request("bedrock", "stream", user("hi"));
  assert.equal("fallbacks" in bedrock.body, false);
});

// @spec LLM-STREAM-007, LLM-STREAM-008
test("claude: stream() delivers each text_delta as a text event, then one done; thinking deltas give no event", async () => {
  for (const kind of claudeKinds) {
    const b = await claudeBackend(({ res }) => sendSse(res, fixture(STREAM[kind])));
    const evs = await collect(claude(kind, b.fetch).stream(user("hi")));
    assert.ok(evs.every((e) => e.type === "text" || e.type === "done"), `${kind}: only text and done events`);
    assert.equal(evs.at(-1).type, "done");
    assert.equal(evs.filter((e) => e.type === "done").length, 1);
    assert.equal(textOf(evs), STREAMED_TEXT[kind]);
    assert.equal(evs.at(-1).result.text, STREAMED_TEXT[kind]);
    assert.doesNotMatch(JSON.stringify(evs.filter((e) => e.type === "text")), /viewer|short line/);
  }
  const b = await claudeBackend(({ res }) => sendSse(res, fixture("anthropic-stream-thinking.sse")));
  const evs = await collect(claude("anthropic", b.fetch).stream(user("hi")));
  assert.deepEqual(evs.map((e) => e.type), ["text", "text", "done"]);
  assert.deepEqual(evs.filter((e) => e.type === "text").map((e) => e.delta), ["[happy] Hi", " there"]);
  assert.equal(evs.at(-1).result.text, "[happy] Hi there");
  assert.equal(evs.at(-1).result.message.content, "[happy] Hi there");
  assert.equal("toolCalls" in evs.at(-1).result.message, false);
});

// @spec LLM-STREAM-013
test("claude: stream() joins the text of several blocks with no separator", async () => {
  const b = await claudeBackend(({ res }) => sendSse(res, fixture("anthropic-stream-two-text.sse")));
  const evs = await collect(claude("anthropic", b.fetch).stream(user("hi")));
  assert.equal(textOf(evs), "[happy] Hello chat!");
  assert.equal(evs.at(-1).result.text, "[happy] Hello chat!");
});

// @spec LLM-STREAM-017
test("claude: a model that thinks longer than llm.timeout_ms before any output fails stream() with a TimeoutError, though thinking deltas keep arriving", async () => {
  const b = await claudeBackend(async ({ res }) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(sseStart + sseEvent("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }));
    for (let i = 0; i < 20 && !res.destroyed; i++) {
      res.write(sseEvent("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm " } }));
      await sleepMs(50);
    }
    res.end();
  });
  const started = Date.now();
  const err = await failure(collect(claude("anthropic", b.fetch, { timeout_ms: 250 }).stream(user("hi"))));
  assert.equal(err?.name, "TimeoutError");
  assert.equal(err instanceof ChatError, false);
  assert.ok(Date.now() - started < 900, "failed at the first-output bound, not after the thinking ended");
});

// @spec LLM-STREAM-027, LLM-STREAM-033
test("claude: a refusal ends stream() with done finish refusal whose text is what was already delivered", async () => {
  for (const kind of claudeKinds) {
    const b = await claudeBackend(({ res }) => sendSse(res, fixture("anthropic-stream-refusal.sse")));
    const evs = await collect(claude(kind, b.fetch).stream(user("hi")));
    assert.equal(textOf(evs), "[happy] I");
    const done = evs.at(-1);
    assert.equal(done.type, "done");
    assert.equal(done.result.finish, "refusal");
    assert.equal(done.result.text, "[happy] I", "delivered text is not blanked");
    assert.deepEqual(done.result.toolCalls, []);
  }
});

// @spec LLM-STREAM-021
test("claude: an error event after the stream began throws a ChatError of kind stream, with no done and no retry", async () => {
  for (const kind of claudeKinds) {
    const b = await claudeBackend(({ res }) => sendSse(res, fixture("anthropic-stream-error.sse")));
    const seen: any[] = [];
    let err: any;
    try { for await (const e of claude(kind, b.fetch).stream(user("hi"))) seen.push(e); } catch (e) { err = e; }
    assert.ok(err instanceof ChatError, `${kind}: ${String(err)}`);
    assert.equal(err.kind, "stream");
    assert.deepEqual(seen.map((e) => e.type), ["text"]);
    assert.equal(b.seen.length, 1, "not retried once the reply began");
  }
});

// @spec LLM-STREAM-021, LLM-CLAUDE-020
test("claude: a connection dropped after the stream began throws a ChatError of kind stream and is not retried", async () => {
  for (const kind of claudeKinds) {
    const b = await claudeBackend(async ({ req, res }) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sseStart + fixture("anthropic-stream-plain.sse").split("\n\n").slice(1, 4).join("\n\n") + "\n\n");
      await sleepMs(30);
      req.socket.destroy();
    });
    const seen: any[] = [];
    let err: any;
    try { for await (const e of claude(kind, b.fetch).stream(user("hi"))) seen.push(e); } catch (e) { err = e; }
    assert.ok(err instanceof ChatError, `${kind}: ${String(err)}`);
    assert.equal(err.kind, "stream");
    assert.equal(seen.some((e) => e.type === "done"), false);
    assert.equal(b.seen.length, 1, "not retried once the reply began");
  }
});

// @spec LLM-ERR-002
test("claude: an SDK error with an HTTP status is a ChatError of kind http carrying it, on chat(), complete() and stream() (before the response began)", async () => {
  for (const kind of claudeKinds) {
    const b = await claudeBackend(({ res }) => sendJson(res, "anthropic-error-401.json", 401));
    const p = claude(kind, b.fetch);
    const errs = [
      await failure(p.chat(user("hi"))),
      await failure(p.complete(user("hi"))),
      await failure(collect(p.stream(user("hi")))),
    ];
    for (const e of errs) {
      assert.ok(e instanceof ChatError, `${kind}: ${String(e)}`);
      assert.equal(e.kind, "http");
      assert.equal(e.status, 401);
    }
    assert.equal(b.seen.length, 3, "a 401 is not retried");
  }
});

// @spec LLM-CLAUDE-020
test("claude: the SDK retries a failed request at most twice before any reply began (complete() and stream())", async () => {
  for (const kind of claudeKinds) for (const call of calls) {
    const recovers = await claudeBackend(({ res, n }) => n < 3 ? sendJson(res, "anthropic-error-401.json", 503, noRetryWait) : answer(kind, call, res));
    const p = claude(kind, recovers.fetch);
    if (call === "complete") assert.equal((await p.complete(user("hi"))).text, TEXT[kind]);
    else assert.equal(textOf(await collect(p.stream(user("hi")))), STREAMED_TEXT[kind]);
    assert.equal(recovers.seen.length, 3, `${kind} ${call}: two retries`);

    const down = await claudeBackend(({ res }) => sendJson(res, "anthropic-error-401.json", 503, noRetryWait));
    const q = claude(kind, down.fetch);
    const err = await failure(call === "complete" ? q.complete(user("hi")) : collect(q.stream(user("hi"))));
    assert.ok(err instanceof ChatError && err.kind === "http" && err.status === 503, `${kind} ${call}: ${String(err)}`);
    assert.equal(down.seen.length, 3, `${kind} ${call}: at most two retries`);
  }
});

// @spec LLM-ERR-003
test("claude: with no credentials every call is a ChatError of kind not_configured, nothing is sent, and stream() throws only on its first read", async () => {
  const b = await claudeBackend(({ res }) => sendJson(res, "anthropic-message.json"));
  const unset = [
    claude("anthropic", b.fetch, {}, { api_key: "" }),
    new BedrockProvider(bedrockCfg({}), { fetch: b.fetch }) as any,
  ];
  for (const p of unset) {
    for (const call of ["chat", "complete"]) {
      const e = await failure(p[call](user("hi")));
      assert.ok(e instanceof ChatError, `${p.name} ${call}: ${String(e)}`);
      assert.equal(e.kind, "not_configured");
      assert.equal(e.status, undefined);
    }
    let it: any;
    assert.doesNotThrow(() => { it = p.stream(user("hi")); });
    const e = await failure(collect(it));
    assert.ok(e instanceof ChatError && e.kind === "not_configured", `${p.name} stream: ${String(e)}`);
  }
  assert.equal(b.seen.length, 0);
  assert.match(String((await failure(unset[0].complete(user("hi"))))?.message), /llm\.claude\.api_key/);
  assert.match(String((await failure(unset[1].complete(user("hi"))))?.message), /llm\.bedrock\.region/);
});

// @spec LLM-ERR-009, LLM-CLAUDE-020
test("claude: a connection that fails before any reply is a ChatError of kind connect with no status, on chat(), complete() and stream(), retried at most twice", async () => {
  const jobs: Promise<void>[] = [];
  for (const kind of claudeKinds) for (const call of ["chat", "complete", "stream"] as const) {
    jobs.push((async () => {
      let attempts = 0;
      const refused = (() => { attempts++; return Promise.reject(new TypeError("fetch failed")); }) as typeof fetch;
      const p = claude(kind, refused);
      const e = await failure(call === "stream" ? collect(p.stream(user("hi"))) : p[call](user("hi")));
      assert.ok(e instanceof ChatError, `${kind} ${call}: ${String(e)}`);
      assert.equal(e.kind, "connect");
      assert.equal(e.status, undefined);
      assert.ok(attempts >= 1 && attempts <= 3, `${kind} ${call}: ${attempts} attempts`);
    })());
  }
  await Promise.all(jobs);
});

// @spec LLM-ERR-001, LLM-ERR-009
test("claude: every failure of a request before its reply is a ChatError, a body the SDK cannot read included", async () => {
  for (const kind of claudeKinds) {
    const b = await claudeBackend(({ res }) => { res.writeHead(200, { "content-type": "application/json" }); res.end("not json"); });
    const e = await failure(claude(kind, b.fetch).complete(user("hi")));
    assert.ok(e instanceof ChatError, `${kind}: ${String(e)}`);
    assert.equal(e.kind, "connect", kind);
    assert.equal(e.status, undefined, kind);
  }
});

// @spec LLM-CHAT-017, LLM-CLAUDE-033
test("claude: an aborted signal passed to complete() cancels the call with the caller's reason, before and during the request", async () => {
  for (const kind of claudeKinds) {
    let closed: Promise<void> | undefined;
    const b = await claudeBackend(async ({ res }) => { closed = new Promise((r) => res.once("close", () => r())); await sleepMs(5000); res.end(); });
    const p = claude(kind, b.fetch, { timeout_ms: 5000 });
    const pre = new Error("pre-aborted");
    assert.equal(await failure(p.complete(user("hi"), { signal: AbortSignal.abort(pre) })), pre, kind);
    assert.equal(b.seen.length, 0, "no request for a signal aborted beforehand");
    const ac = new AbortController();
    const reason = new Error("caller gave up");
    const pending = failure(p.complete(user("hi"), { signal: ac.signal }));
    await sleepMs(100);
    ac.abort(reason);
    assert.equal(await pending, reason, kind);
    await Promise.race([closed, sleepMs(2000).then(() => assert.fail(`${kind}: request not cancelled`))]);
  }
});

// @spec LLM-CHAT-018, LLM-ERR-005
test("claude: with no signal complete() is bounded by llm.timeout_ms: a black-holed backend fails once with TimeoutError, within 1.5x the timeout, with one request and no SDK retry", async () => {
  for (const kind of claudeKinds) {
    const b = await claudeBackend(async () => { await sleepMs(30_000); });
    const timeout = 150;
    const started = Date.now();
    const err = await failure(claude(kind, b.fetch, { timeout_ms: timeout }).complete(user("hi")));
    const elapsed = Date.now() - started;
    assert.equal(err?.name, "TimeoutError", kind);
    assert.equal(err instanceof ChatError, false, `${kind}: a timeout is not a ChatError`);
    assert.ok(elapsed < timeout * 1.5, `${kind}: failed after ${elapsed} ms`);
    assert.equal(b.seen.length, 1, `${kind}: one request, not retried on a timeout`);
  }
});

// @spec LLM-CHAT-018, LLM-ERR-005
test("claude: the complete() timeout bounds the whole call: a 5xx first attempt, then a retry that hangs, rejects at llm.timeout_ms with TimeoutError", async () => {
  for (const kind of claudeKinds) {
    const b = await claudeBackend(async ({ res, n }) => {
      if (n === 1) { sendJson(res, "anthropic-error-401.json", 503, noRetryWait); return; }
      await sleepMs(30_000);
    });
    const timeout = 300;
    const started = Date.now();
    const err = await failure(claude(kind, b.fetch, { timeout_ms: timeout }).complete(user("hi")));
    const elapsed = Date.now() - started;
    assert.equal(err?.name, "TimeoutError", kind);
    assert.equal(err instanceof ChatError, false, `${kind}: a timeout is not a ChatError`);
    assert.ok(elapsed < timeout * 2, `${kind}: failed after ${elapsed} ms, not one timeout per attempt`);
    assert.equal(b.seen.length, 2, `${kind}: the failed attempt and the hanging retry, and no third`);
  }
});

// @spec LLM-CLAUDE-019, LLM-CLAUDE-022, LLM-CLAUDE-032
test("claude: the hostile environment changes nothing on complete() and stream() either (credential, endpoint, headers, betas)", async () => {
  await withEnv(HOSTILE_SDK_ENV, async () => {
    for (const call of calls) {
      const a = await claudeBackend(({ res }) => answer("anthropic", call, res));
      const p = claude("anthropic", a.fetch);
      if (call === "complete") await p.complete(user("hi")); else await collect(p.stream(user("hi")));
      const h = a.seen[0]!.headers;
      assert.equal(new URL(a.urls[0]!).origin, "https://api.anthropic.com", call);
      assert.equal(h.authorization, "Bearer sk-config");
      assert.equal(h["x-api-key"], undefined);
      assert.doesNotMatch(String(h["anthropic-beta"] ?? ""), /evil/);
      if (call === "stream") assert.equal(h["anthropic-beta"], undefined, "no fallback beta on a stream, and none injected");

      const b = await claudeBackend(({ res }) => answer("bedrock", call, res));
      const q = claude("bedrock", b.fetch);
      if (call === "complete") await q.complete(user("hi")); else await collect(q.stream(user("hi")));
      assert.equal(new URL(b.urls[0]!).origin, "https://bedrock-mantle.eu-west-2.api.aws", call);
      const bh = b.seen[0]!.headers;
      assert.match(String(bh.authorization), /^AWS4-HMAC-SHA256 Credential=AKIACONFIG\//);
      assert.equal(bh["anthropic-beta"], undefined);
      assert.equal(bh["x-amz-security-token"], undefined);
    }
  });
});

// ---- tool use and turn continuation on the Claude API and Bedrock (issue #163)

const weatherTool = { name: "get_weather", description: "Weather for a city", parameters: { type: "object", properties: { city: { type: "string" } } } };
const clockTool = { name: "get-time", description: "Current time", parameters: { type: "object", properties: {} } };
/** The tool_use ids the recorded tool replies carry, by provider. */
const TU_A: Record<ClaudeKind, string> = { anthropic: "toolu_01A", bedrock: "toolu_bdrk_01A" };
const TU_B: Record<ClaudeKind, string> = { anthropic: "toolu_01B", bedrock: "toolu_bdrk_01B" };
const THINKING = "The viewer asked about Oslo; check the weather.";
const asked = (id: string, name = "get_weather", args: Record<string, unknown> = { city: "Oslo" }) => ({ id, name, arguments: args });

/** Answers every request with the recorded `<provider>-<name>` (a `.sse` file streams, a `.json` file is one message). */
async function toolBackend(kind: ClaudeKind, name: string) {
  const file = `${kind}-${name}`;
  return claudeBackend(({ res }) => (file.endsWith(".sse") ? sendSse(res, fixture(file)) : sendJson(res, file)));
}
/** Runs `complete()` or `stream()` against a recorded tool reply and returns the request, the result and the stream's events. */
async function toolRun(kind: ClaudeKind, call: "complete" | "stream", name: string, history: any[] = user("hi"), req: Record<string, unknown> = { tools: [weatherTool] }) {
  const b = await toolBackend(kind, call === "complete" ? `${name}.json` : `stream-${name}.sse`);
  const p = claude(kind, b.fetch);
  if (call === "complete") return { seen: b.seen, result: await p.complete(history, req), events: [] as any[] };
  const events = await collect(p.stream(history, req));
  assert.equal(events.at(-1).type, "done");
  return { seen: b.seen, result: events.at(-1).result, events };
}
const bodyOf = (s: { body: Record<string, unknown> }): any => s.body;
const sentMessages = (s: { body: Record<string, unknown> }): any[] => bodyOf(s).messages;

// @spec LLM-TOOL-010, LLM-STOP-010
test("claude and bedrock: tools go out as [{name, description, input_schema}] and no stop_sequences key is sent, from complete() and stream()", async () => {
  for (const kind of claudeKinds) {
    for (const call of calls) {
      const { seen } = await toolRun(kind, call, "tool-use", user("hi"), { tools: [weatherTool, clockTool] });
      const body = bodyOf(seen[0]!);
      assert.deepEqual(body.tools, [
        { name: "get_weather", description: "Weather for a city", input_schema: weatherTool.parameters },
        { name: "get-time", description: "Current time", input_schema: clockTool.parameters },
      ], `${kind} ${call}`);
      assert.equal("stop_sequences" in body, false, `${kind} ${call}: stop_sequences sent`);
    }
  }
});

// @spec LLM-STOP-019, LLM-TOOL-026
test("claude and bedrock: tools [] is no tools: the reply stops are sent, no tools key goes out, and json:true does not fail", async () => {
  for (const kind of claudeKinds) {
    for (const call of calls) {
      const reply = await request(kind, call, user("hi"), { tools: [] });
      assert.deepEqual(bodyOf(reply).stop_sequences, TRANSCRIPT_STOPS, `${kind} ${call}`);
      assert.equal("tools" in bodyOf(reply), false, `${kind} ${call}: tools key sent`);
      const json = await request(kind, call, user("hi"), { tools: [], json: true });
      assert.equal("stop_sequences" in bodyOf(json), false, `${kind} ${call} json`);
      assert.equal("tools" in bodyOf(json), false, `${kind} ${call} json: tools key sent`);
    }
  }
});

// @spec LLM-TOOL-011, LLM-TOOL-020, LLM-IF-018
test("claude and bedrock: a tool_use block gives a call with the backend's id, name and input, and the reply finishes tool_calls, from complete() and stream()", async () => {
  for (const kind of claudeKinds) {
    for (const call of calls) {
      const { result } = await toolRun(kind, call, "tool-use");
      assert.deepEqual(result.toolCalls, [asked(TU_A[kind])], `${kind} ${call}`);
      assert.equal(result.finish, "tool_calls", `${kind} ${call}`);
      assert.equal(result.text, "Let me look.", `${kind} ${call}`);
      assert.equal(result.message.content, "Let me look.");
      assert.deepEqual(result.message.toolCalls, result.toolCalls);
    }
  }
});

// @spec LLM-TOOL-011, LLM-TOOL-024, LLM-IF-018
test("claude and bedrock: several tool_use blocks come back in the order the model asked, with the no-argument call's input {}", async () => {
  for (const kind of claudeKinds) {
    for (const call of calls) {
      const { result } = await toolRun(kind, call, "tool-use-two", user("hi"), { tools: [weatherTool, clockTool] });
      assert.deepEqual(result.toolCalls, [asked(TU_A[kind]), asked(TU_B[kind], "get-time", {})], `${kind} ${call}`);
      assert.equal(result.finish, "tool_calls");
      assert.equal(result.text, "");
    }
  }
});

// @spec LLM-TOOL-021
test("claude and bedrock: a model offered tools that asks for none returns its text with an empty toolCalls and no toolCalls on the message", async () => {
  for (const kind of claudeKinds) {
    for (const call of calls) {
      const b = await claudeBackend(({ res }) => answer(kind, call, res));
      const p = claude(kind, b.fetch);
      const r = call === "complete" ? await p.complete(user("hi"), { tools: [weatherTool] }) : (await collect(p.stream(user("hi"), { tools: [weatherTool] }))).at(-1).result;
      assert.deepEqual(r.toolCalls, [], `${kind} ${call}`);
      assert.equal("toolCalls" in r.message, false);
      assert.equal(r.finish, "stop");
      assert.ok(r.text.length > 0);
    }
  }
});

// @spec LLM-IF-018
test("claude and bedrock: stop_reason tool_use maps to tool_calls, max_tokens to length and refusal to refusal (a refusal empties text and calls), from complete() and stream()", async () => {
  for (const kind of claudeKinds) {
    for (const call of calls) {
      for (const [reason, finish] of [["tool_use", "tool_calls"], ["max_tokens", "length"], ["refusal", "refusal"]] as const) {
        const file = call === "complete" ? `${kind}-tool-use-thinking.json` : `${kind}-stream-tool-use.sse`;
        const body = fixture(file).replace(/"stop_reason": ?"tool_use"/, `"stop_reason": "${reason}"`);
        const b = await claudeBackend(({ res }) => {
          if (call === "complete") { res.writeHead(200, { "content-type": "application/json" }); res.end(body); } else sendSse(res, body);
        });
        const p = claude(kind, b.fetch);
        const r = call === "complete" ? await p.complete(user("hi"), { tools: [weatherTool] }) : (await collect(p.stream(user("hi"), { tools: [weatherTool] }))).at(-1).result;
        assert.equal(r.finish, finish, `${kind} ${call} ${reason}`);
        if (reason === "refusal" && call === "complete") {
          assert.equal(r.text, "");
          assert.deepEqual(r.toolCalls, []);
        }
      }
    }
  }
});

// @spec LLM-TOOL-022, LLM-IF-018
test("claude and bedrock: complete() drops the call the token cap cut off, keeps the completed one, and finishes length", async () => {
  for (const kind of claudeKinds) {
    const { result } = await toolRun(kind, "complete", "tool-use-max-tokens", user("hi"), { tools: [weatherTool, clockTool] });
    assert.deepEqual(result.toolCalls, [asked(TU_A[kind])], kind);
    assert.equal(result.finish, "length");
  }
});

// @spec LLM-STREAM-030, LLM-TOOL-023, LLM-TOOL-022, LLM-STREAM-032, LLM-IF-018
test("claude and bedrock: stream() never delivers a call the cap cut off; the completed call is delivered and done finishes length with the same calls", async () => {
  for (const kind of claudeKinds) {
    const { events, result } = await toolRun(kind, "stream", "tool-use-max-tokens", user("hi"), { tools: [weatherTool] });
    const delivered = events.filter((e) => e.type === "tool_call").map((e) => e.call);
    assert.deepEqual(delivered, [asked(TU_A[kind])], kind);
    assert.deepEqual(result.toolCalls, delivered);
    assert.equal(result.finish, "length");
  }
});

// @spec LLM-STREAM-030, LLM-TOOL-011, LLM-TOOL-020, LLM-STREAM-032
test("claude and bedrock: stream() assembles input_json_delta fragments and delivers the call as one tool_call after the text, immediately before done", async () => {
  for (const kind of claudeKinds) {
    const { events, result } = await toolRun(kind, "stream", "tool-use");
    assert.deepEqual(events.map((e) => e.type), ["text", "tool_call", "done"], kind);
    assert.equal(events[0].delta, "Let me look.");
    assert.deepEqual(events[1].call, asked(TU_A[kind]));
    assert.deepEqual(result.toolCalls, [events[1].call]);
    assert.equal(result.finish, "tool_calls");
    assert.equal(result.text, "Let me look.");
  }
});

// @spec LLM-STREAM-030
test("claude and bedrock: stream() holds a finished call until the final message delta has reported stop_reason", async () => {
  for (const kind of claudeKinds) {
    const all = fixture(`${kind}-stream-tool-use.sse`);
    const cut = all.indexOf("event: message_delta");
    assert.ok(cut > 0);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const b = await claudeBackend(async ({ res }) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(all.slice(0, cut)); // every block, including the whole tool_use block, but not the final delta
      await gate;
      res.end(all.slice(cut));
    });
    const it = claude(kind, b.fetch).stream(user("hi"), { tools: [weatherTool] })[Symbol.asyncIterator]();
    const first = await it.next();
    assert.equal(first.value.type, "text");
    const pending = it.next();
    const early = await Promise.race([pending.then(() => "event"), sleepMs(300).then(() => "held")]);
    assert.equal(early, "held", `${kind}: an event arrived before stop_reason`);
    release();
    assert.equal((await pending).value.type, "tool_call");
    assert.equal((await it.next()).value.type, "done");
  }
});

// @spec LLM-STREAM-032, LLM-TOOL-024
test("claude and bedrock: done.result.toolCalls equals the tool_call events, in order, for several calls", async () => {
  for (const kind of claudeKinds) {
    const { events, result } = await toolRun(kind, "stream", "tool-use-two", user("hi"), { tools: [weatherTool, clockTool] });
    assert.deepEqual(events.map((e) => e.type), ["tool_call", "tool_call", "done"], kind);
    assert.deepEqual(events.slice(0, 2).map((e) => e.call), [asked(TU_A[kind]), asked(TU_B[kind], "get-time", {})]);
    assert.deepEqual(result.toolCalls, events.slice(0, 2).map((e) => e.call));
  }
});

// @spec LLM-TOOL-016
test("claude and bedrock: streamed input that is not a JSON object gives {} with invalid set to the raw text", async () => {
  for (const kind of claudeKinds) {
    const sse = fixture(`${kind}-stream-tool-use-two.sse`).replace('{\\"city\\": \\"Oslo\\"}', "[1, 2]");
    assert.match(sse, /\[1, 2\]/);
    const b = await claudeBackend(({ res }) => sendSse(res, sse));
    const evs = await collect(claude(kind, b.fetch).stream(user("hi"), { tools: [weatherTool, clockTool] }));
    assert.deepEqual(evs.find((e) => e.type === "tool_call").call, { id: TU_A[kind], name: "get_weather", arguments: {}, invalid: "[1, 2]" }, kind);
  }
});

// @spec LLM-TOOL-014, LLM-TOOL-030
test("claude and bedrock: result.message.continuation carries the provider name and keeps the thinking blocks and the calls, from complete() and stream()", async () => {
  for (const kind of claudeKinds) {
    for (const call of calls) {
      const { result } = await toolRun(kind, call, call === "complete" ? "tool-use-thinking" : "tool-use");
      const c = result.message.continuation;
      assert.equal(c.name, kind, `${kind} ${call}`);
      const dump = JSON.stringify(c);
      assert.ok(dump.includes(THINKING), `${kind} ${call}: thinking text missing from the continuation`);
      assert.ok(dump.includes("fixture-signature"), `${kind} ${call}: thinking signature missing`);
      assert.ok(dump.includes(TU_A[kind]), `${kind} ${call}: the call is missing`);
    }
  }
});

/** Appends the results of the model's calls to a history that holds the assistant message `r.message`. */
const withResults = (r: any, ...results: any[]) => [...user("hi"), r.message, ...results];
const rain = { role: "tool" as const, callId: "", name: "get_weather", content: "rain" };

// @spec LLM-TOOL-013
test("claude and bedrock: an assistant turn with calls is sent as its thinking blocks, then tool_use blocks, and no text block while content is empty", async () => {
  for (const kind of claudeKinds) {
    for (const call of calls) {
      const first = await toolRun(kind, call, "tool-use-two", user("hi"), { tools: [weatherTool, clockTool] });
      const results = [{ ...rain, callId: TU_A[kind] }, { role: "tool" as const, callId: TU_B[kind], name: "get-time", content: "noon" }];
      const b = await toolBackend(kind, "tool-use.json");
      await claude(kind, b.fetch).complete(withResults(first.result, ...results), { tools: [weatherTool, clockTool] });
      const sent = sentMessages(b.seen[0]!);
      const asst = sent.find((m) => m.role === "assistant");
      assert.deepEqual(asst.content.map((x: any) => x.type), ["thinking", "tool_use", "tool_use"], `${kind} ${call}`);
      assert.equal(asst.content[0].thinking, THINKING);
      assert.equal(asst.content[0].signature, "fixture-signature");
      assert.deepEqual(asst.content.slice(1).map((x: any) => [x.id, x.name, x.input]), [[TU_A[kind], "get_weather", { city: "Oslo" }], [TU_B[kind], "get-time", {}]]);
    }
  }
});

// @spec LLM-TOOL-013
test("claude and bedrock: an assistant turn with its own continuation is sent back verbatim from the continuation's blocks, whatever its content", async () => {
  for (const kind of claudeKinds) {
    const first = await toolRun(kind, "complete", "tool-use-thinking");
    const message = { ...first.result.message, content: "Let me look." };
    const b = await toolBackend(kind, "tool-use.json");
    await claude(kind, b.fetch).complete([...user("hi"), message, { ...rain, callId: TU_A[kind] }], { tools: [weatherTool] });
    const asst = sentMessages(b.seen[0]!).find((m) => m.role === "assistant");
    assert.deepEqual(asst.content, first.result.message.continuation.content, kind);
    assert.deepEqual(asst.content.map((x: any) => x.type), ["thinking", "tool_use"], kind);
  }
});

// @spec LLM-TOOL-013
test("claude and bedrock: an assistant turn with calls and no own continuation is sent as a text block when content is non-empty, then tool_use blocks, with no thinking", async () => {
  for (const kind of claudeKinds) {
    const first = await toolRun(kind, "complete", "tool-use-thinking");
    const { continuation: _dropped, ...rest } = first.result.message;
    const message = { ...rest, content: "Let me look." };
    const b = await toolBackend(kind, "tool-use.json");
    await claude(kind, b.fetch).complete([...user("hi"), message, { ...rain, callId: TU_A[kind] }], { tools: [weatherTool] });
    const asst = sentMessages(b.seen[0]!).find((m) => m.role === "assistant");
    assert.deepEqual(asst.content.map((x: any) => x.type), ["text", "tool_use"], kind);
    assert.equal(asst.content[0].text, "Let me look.");
  }
});

/** The two recorded orders of content blocks, as the API sent them, for each provider (LLM-TOOL-014). */
const ORDER_TEXT = (kind: ClaudeKind) => [
  { type: "thinking", thinking: "First, the viewer's question.", signature: "sig-1" },
  { type: "text", text: "Let me check." },
  { type: "thinking", thinking: "Oslo, so the weather tool.", signature: "sig-2" },
  { type: "tool_use", id: TU_A[kind], name: "get_weather", input: { city: "Oslo" } },
];
const ORDER_CALLS = (kind: ClaudeKind) => [
  { type: "thinking", thinking: "Two lookups.", signature: "sig-a" },
  { type: "tool_use", id: TU_A[kind], name: "get_weather", input: { city: "Oslo" } },
  { type: "thinking", thinking: "And the time.", signature: "sig-b" },
  { type: "tool_use", id: TU_B[kind], name: "get-time", input: {} },
];

// @spec LLM-TOOL-014, LLM-TOOL-013, LLM-STREAM-032
test("claude and bedrock: thinking, text, thinking, tool_use keeps the blocks in the order sent, and the next turn sends them back in that order, from complete() and stream()", async () => {
  for (const kind of claudeKinds) {
    for (const call of calls) {
      const { result } = await toolRun(kind, call, "tool-use-order-text", user("hi"), { tools: [weatherTool, clockTool] });
      assert.deepEqual(result.message.continuation.content, ORDER_TEXT(kind), `${kind} ${call}`);
      assert.deepEqual(result.toolCalls, [asked(TU_A[kind])], `${kind} ${call}`);
      const b = await toolBackend(kind, "tool-use.json");
      await claude(kind, b.fetch).complete(withResults(result, { ...rain, callId: TU_A[kind] }), { tools: [weatherTool] });
      assert.deepEqual(sentMessages(b.seen[0]!).find((m) => m.role === "assistant").content, ORDER_TEXT(kind), `${kind} ${call} sent`);
    }
  }
});

// @spec LLM-TOOL-014, LLM-TOOL-013, LLM-STREAM-032
test("claude and bedrock: thinking, tool_use, thinking, tool_use keeps both calls and the blocks between them in order, and sends them back verbatim, from complete() and stream()", async () => {
  for (const kind of claudeKinds) {
    for (const call of calls) {
      const { result } = await toolRun(kind, call, "tool-use-order-calls", user("hi"), { tools: [weatherTool, clockTool] });
      assert.deepEqual(result.message.continuation.content, ORDER_CALLS(kind), `${kind} ${call}`);
      assert.deepEqual(result.toolCalls, [asked(TU_A[kind]), asked(TU_B[kind], "get-time", {})], `${kind} ${call}`);
      const b = await toolBackend(kind, "tool-use.json");
      await claude(kind, b.fetch).complete(withResults(result, { ...rain, callId: TU_A[kind] }), { tools: [weatherTool, clockTool] });
      assert.deepEqual(sentMessages(b.seen[0]!).find((m) => m.role === "assistant").content, ORDER_CALLS(kind), `${kind} ${call} sent`);
    }
  }
});

// @spec LLM-STREAM-030, LLM-TOOL-022, LLM-IF-018
test("claude and bedrock: a no-argument call completed before a text block the cap cuts off is kept; the reply finishes length and the text block is kept in the continuation", async () => {
  for (const kind of claudeKinds) {
    const complete = await toolRun(kind, "complete", "tool-use-cut-after-call", user("hi"), { tools: [weatherTool, clockTool] });
    assert.deepEqual(complete.result.toolCalls, [asked(TU_A[kind], "get-time", {})], `${kind} complete`);
    assert.equal(complete.result.finish, "length", `${kind} complete`);
    const streamed = await toolRun(kind, "stream", "tool-use-cut-after-call", user("hi"), { tools: [weatherTool, clockTool] });
    assert.deepEqual(streamed.events.filter((e) => e.type === "tool_call").map((e) => e.call), [asked(TU_A[kind], "get-time", {})], `${kind} stream`);
    assert.equal(streamed.result.finish, "length", `${kind} stream`);
    assert.equal(streamed.result.text, "Let me", `${kind} stream`);
    assert.deepEqual(streamed.result.message.continuation.content, [
      { type: "tool_use", id: TU_A[kind], name: "get-time", input: {} },
      { type: "text", text: "Let me" },
    ], `${kind} stream`);
  }
});

// @spec LLM-STREAM-038, LLM-CLAUDE-021, LLM-STREAM-033
test("claude and bedrock: a refused stream() delivers no tool_call event, done.result.toolCalls is empty and it carries no continuation, also when a call was being written", async () => {
  for (const kind of claudeKinds) {
    for (const [file, label] of [["stream-tool-use", "a whole call"], ["stream-tool-use-max-tokens", "a call the cap would cut"]] as const) {
      const body = fixture(`${kind}-${file}.sse`).replace(/"stop_reason": ?"(tool_use|max_tokens)"/, '"stop_reason": "refusal"');
      const b = await claudeBackend(({ res }) => sendSse(res, body));
      const events = await collect(claude(kind, b.fetch).stream(user("hi"), { tools: [weatherTool, clockTool] }));
      assert.equal(events.some((e) => e.type === "tool_call"), false, `${kind} ${label}`);
      const done = events.at(-1);
      assert.equal(done.type, "done", `${kind} ${label}`);
      assert.equal(done.result.finish, "refusal", `${kind} ${label}`);
      assert.deepEqual(done.result.toolCalls, [], `${kind} ${label}`);
      assert.equal("continuation" in done.result.message, false, `${kind} ${label}`);
    }
  }
});

// @spec LLM-TOOL-011, LLM-STREAM-030
test("claude and bedrock: a tool_use block that starts with its input and gets no input deltas delivers that input as the call's arguments", async () => {
  for (const kind of claudeKinds) {
    const sse = fixture(`${kind}-stream-tool-use.sse`)
      .replace('"id":"toolu_01A","name":"get_weather","input":{}', '"id":"toolu_01A","name":"get_weather","input":{"city":"Oslo"}')
      .replace(/event: content_block_delta\ndata: \{[^\n]*"index":1,"delta":\{"type":"input_json_delta"[^\n]*\n\n/, "");
    assert.doesNotMatch(sse, /"index":1,"delta":\{"type":"input_json_delta"/, kind);
    const b = await claudeBackend(({ res }) => sendSse(res, sse));
    const events = await collect(claude(kind, b.fetch).stream(user("hi"), { tools: [weatherTool] }));
    assert.deepEqual(events.find((e) => e.type === "tool_call").call, asked(TU_A[kind]), kind);
  }
});

// @spec LLM-TOOL-012, LLM-TOOL-025
test("claude and bedrock: consecutive tool messages go out as tool_result blocks of one user turn, in the order given, each answering its own callId with is_error where set", async () => {
  for (const kind of claudeKinds) {
    for (const call of calls) {
      const first = await toolRun(kind, call, "tool-use-two", user("hi"), { tools: [weatherTool, clockTool] });
      // Results given in the opposite order to the calls: sent as given, each under the call its callId names.
      const results = [
        { role: "tool" as const, callId: TU_B[kind], name: "get-time", content: "boom", isError: true },
        { role: "tool" as const, callId: TU_A[kind], name: "get_weather", content: "rain" },
      ];
      const b = await toolBackend(kind, "tool-use.json");
      await claude(kind, b.fetch).complete(withResults(first.result, ...results), { tools: [weatherTool, clockTool] });
      const sent = sentMessages(b.seen[0]!);
      const turn = sent.at(-1);
      assert.equal(turn.role, "user", `${kind} ${call}`);
      assert.equal(sent.filter((m) => m.role === "user").length, 2, "the results share one user turn");
      assert.deepEqual(turn.content.map((x: any) => x.type), ["tool_result", "tool_result"]);
      assert.deepEqual(turn.content.map((x: any) => x.tool_use_id), [TU_B[kind], TU_A[kind]]);
      assert.deepEqual(turn.content.map((x: any) => x.content), ["boom", "rain"]);
      assert.equal(turn.content[0].is_error, true);
      assert.notEqual(turn.content[1].is_error, true);
    }
  }
});

// @spec LLM-TOOL-017
test("claude and bedrock: an assistant call with invalid goes back with input {} and the raw text never reaches the model", async () => {
  for (const kind of claudeKinds) {
    const bad = { id: TU_A[kind], name: "get_weather", arguments: {}, invalid: "{oops" };
    const history = [...user("hi"), { role: "assistant" as const, content: "", toolCalls: [bad] },
      { role: "tool" as const, callId: TU_A[kind], name: "get_weather", content: "arguments were not JSON", isError: true }];
    const b = await toolBackend(kind, "tool-use.json");
    await claude(kind, b.fetch).complete(history, { tools: [weatherTool] });
    const asst = sentMessages(b.seen[0]!).find((m) => m.role === "assistant");
    assert.deepEqual(asst.content.filter((x: any) => x.type === "tool_use").map((x: any) => x.input), [{}], kind);
    assert.doesNotMatch(JSON.stringify(asst), /oops/);
  }
});

// @spec LLM-TOOL-015, LLM-TOOL-030
test("claude and bedrock: a continuation from the other Claude provider (or any other provider) is ignored: the turn goes out with no thinking blocks", async () => {
  const other: Record<ClaudeKind, ClaudeKind> = { anthropic: "bedrock", bedrock: "anthropic" };
  for (const kind of claudeKinds) {
    const foreign = await toolRun(other[kind], "complete", "tool-use-thinking");
    assert.equal(foreign.result.message.continuation.name, other[kind]);
    const history = [...user("hi"), foreign.result.message, { ...rain, callId: TU_A[other[kind]] }];
    const b = await toolBackend(kind, "tool-use.json");
    await claude(kind, b.fetch).complete(history, { tools: [weatherTool] });
    const asst = sentMessages(b.seen[0]!).find((m) => m.role === "assistant");
    assert.deepEqual(asst.content.map((x: any) => x.type), ["tool_use"], `${kind} sent ${other[kind]}'s continuation`);
    assert.doesNotMatch(JSON.stringify(sentMessages(b.seen[0]!)), /fixture-signature/);
    // A continuation naming a provider that is not Claude is ignored the same way.
    const ollama = { ...foreign.result.message, continuation: { name: "ollama", thinking: "x" } };
    const b2 = await toolBackend(kind, "tool-use.json");
    await claude(kind, b2.fetch).complete([...user("hi"), ollama, { ...rain, callId: TU_A[other[kind]] }], { tools: [weatherTool] });
    assert.deepEqual(sentMessages(b2.seen[0]!).find((m) => m.role === "assistant").content.map((x: any) => x.type), ["tool_use"]);
  }
});

after(() => { /* servers are closed per test in try/finally */ });
