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
  AnthropicProvider, BedrockProvider, MockProvider, Ollama, OpenAICompatible, TRANSCRIPT_STOPS, createChatProvider,
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
      const p = new AnthropicProvider(llmCfg({ provider: "anthropic", model: "claude-fixture", claude: { api_key: "sk-fixture" } }), undefined, { fetch: srv.fetch });
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
      const p = new AnthropicProvider(llmCfg({ provider: "anthropic", model: "claude-fixture", claude: { api_key: "k", fallbacks: false } }), undefined, { fetch: srv.fetch });
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
      const p = new AnthropicProvider(llmCfg({ provider: "anthropic", model: "claude-fixture", claude: { api_key: "k", max_tokens: 1536 } }), undefined, { fetch: srv.fetch });
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
    const p = new AnthropicProvider(llmCfg({ provider: "anthropic", model: "claude-fixture", claude: { api_key: "k" } }), undefined, { fetch: srv.fetch });
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
      const p = new AnthropicProvider(llmCfg({ provider: "anthropic", model: "claude-fixture", claude: { api_key: "sk-config" } }), undefined, { fetch: srv.fetch });
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
      const p = new AnthropicProvider(llmCfg({ provider: "anthropic", model: "claude-fixture", claude: { api_key: "" } }), undefined, { fetch: srv.fetch });
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
      const p = new AnthropicProvider(llmCfg({ provider: "anthropic", model: "claude-fixture", claude: { api_key: "bad" } }), undefined, { fetch: srv.fetch });
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
    const b = new BedrockProvider(bedrockCfg(CONFIGURED), undefined, { fetch: srv.fetch });
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
      const b = new BedrockProvider(bedrockCfg(CONFIGURED), undefined, { fetch: srv.fetch });
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
        const b = new BedrockProvider(bedrockCfg(bedrock), undefined, { fetch: srv.fetch });
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
  return [...names].sort();
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
      const p = new AnthropicProvider(llmCfg({ provider: "anthropic", model: "claude-fixture", claude: { api_key: "sk-config" } }), undefined, { fetch: srv.fetch });
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
    const p = new AnthropicProvider(llmCfg({ provider: "anthropic", model: "claude-fixture", claude: { api_key: "sk-config" } }), undefined, { fetch: srv.fetch });
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
      const b = new BedrockProvider(bedrockCfg(CONFIGURED), undefined, { fetch: srv.fetch });
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
  assert.equal(await p.ping(), true, p.lastError);
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
  ctx.pushSelf("welcome", "happy");
  const lines = ctx.transcript("Coco").split("\n");
  const tags = lines.map((l) => /^\[[a-z]+\]/.exec(l)?.[0]);
  assert.equal(lines.length, 4);
  assert.equal(tags[3], undefined, "the co-host's own line carries no tag");
  tags.length = 3;
  assert.ok(tags.every((t) => t !== undefined));
  assert.deepEqual(TRANSCRIPT_STOPS, tags.map((t) => `\n${t}`));
  assert.equal(TRANSCRIPT_STOPS.some((s) => s.startsWith("\nCoco")), false, "the co-host's own line is not a stop");
});

after(() => { /* servers are closed per test in try/finally */ });
