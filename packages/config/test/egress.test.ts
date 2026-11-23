import { test, mock } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns";
import { ConfigSchema, egressDestinations, type Config } from "../src/index.js";
import { isolateEnv } from "./helpers/config-sandbox.js";

isolateEnv();

const base = () => ({
  cohost: { name: "a", streamer: "b" }, llm: { model: "m", embed_model: "e" }, vision: { model: "v", obs: {} }, chat: { twitch: {} },
  voice: {}, avatar: { vtube_studio: { host: "h" }, vmc: { host: "h" } }, ears: {}, dashboard: {}, brain: {},
});
const cfg = (over: Record<string, unknown> = {}): Config => ConfigSchema.parse({ ...base(), ...over });
const entries = (over: Record<string, unknown> = {}) => egressDestinations(cfg(over));
const of = (over: Record<string, unknown>, service: string) => entries(over).filter((e) => e.service === service);
const one = (over: Record<string, unknown>, service: string) => {
  const found = of(over, service);
  assert.equal(found.length, 1, `${service}: ${JSON.stringify(found)}`);
  return found[0]!;
};
/** A voice (openai) config pointing at `url`, the simplest way to judge one host. */
const voiceAt = (url: string, lan?: string[]) => one({ voice: { engine: "openai", voice: "v", openai: { base_url: url, model: "m" } }, ...(lan ? { network: { lan } } : {}) }, "voice");
const offLan = (host: string, lan?: string[]): boolean => voiceAt(`http://${host}:8000/v1`, lan).offLan;

// @spec CFG-EGR-001
test("egressDestinations is a pure function returning entries with service, data, engine, host, hosted and offLan, and the default config has voice, ears, eyes and cortex", () => {
  const list = entries();
  assert.deepEqual(list.map((e) => `${e.service}:${e.data}`).sort(), ["cortex:text", "ears:audio", "eyes:frames", "voice:text"]);
  for (const e of list) {
    assert.equal(typeof e.engine, "string");
    assert.equal(typeof e.offLan, "boolean");
    assert.ok(e.host === undefined || typeof e.host === "string");
    assert.ok(e.hosted === undefined || typeof e.hosted === "string");
  }
  const c = cfg();
  const before = JSON.stringify(c);
  egressDestinations(c);
  assert.equal(JSON.stringify(c), before, "the config is not changed");
});

// @spec CFG-EGR-002
test("voice has an entry of data text per engine but stub: kokoro at the urls.tts() host, openai and pocket at their own, none while blank", () => {
  process.env.TTS_URL = "http://tts:8880";
  const k = one({}, "voice");
  assert.deepEqual([k.data, k.engine, k.host, k.offLan], ["text", "kokoro", "tts", false]);
  delete process.env.TTS_URL;
  assert.equal(one({}, "voice").host, "127.0.0.1");
  const o = one({ voice: { engine: "openai", voice: "v", openai: { base_url: "https://api.openai.com/v1", model: "tts-1" } } }, "voice");
  assert.deepEqual([o.engine, o.host, o.offLan], ["openai", "api.openai.com", true]);
  const p = one({ voice: { engine: "pocket" } }, "voice");
  assert.deepEqual([p.engine, p.host, p.offLan], ["pocket", "tts-pocket", false]);
  assert.equal(one({ voice: { engine: "pocket", pocket: { url: "http://gpu.lan:9000/" } } }, "voice").host, "gpu.lan");
  assert.deepEqual(of({ voice: { engine: "stub" } }, "voice"), []);
  assert.deepEqual(of({ voice: { engine: "openai", voice: "v", openai: { base_url: "", model: "m" } } }, "voice"), []);
  assert.deepEqual(of({ voice: { engine: "pocket", pocket: { url: "" } } }, "voice"), []);
});

// @spec CFG-EGR-003
test("ears has an entry of data audio for the selected engine, and for the fallback only while the selected engine is nemotron or kyutai and the fallback is not none", () => {
  process.env.STT_URL = "http://stt:8000";
  const s = one({}, "ears");
  assert.deepEqual([s.data, s.engine, s.host, s.offLan], ["audio", "speaches", "stt", false]);
  delete process.env.STT_URL;
  assert.equal(one({}, "ears").host, "127.0.0.1");
  assert.deepEqual(of({ ears: { stt_engine: "stub" } }, "ears"), []);
  const hosted = { openai: { base_url: "https://api.openai.com/v1" } };
  const o = of({ ears: { stt_engine: "openai", stt_fallback_engine: "speaches", ...hosted } }, "ears");
  assert.deepEqual(o.map((e) => [e.engine, e.host]), [["openai", "api.openai.com"]], "no fallback entry while the selected engine is openai");
  const n = of({ ears: { stt_engine: "nemotron", stt_fallback_engine: "openai", ...hosted } }, "ears");
  assert.deepEqual(n.map((e) => [e.engine, e.host, e.offLan]).sort(), [["nemotron", "stt-nemotron", false], ["openai", "api.openai.com", true]]);
  const k = of({ ears: { stt_engine: "kyutai", stt_fallback_engine: "speaches" } }, "ears");
  assert.deepEqual(k.map((e) => [e.engine, e.host]).sort(), [["kyutai", "stt-kyutai"], ["speaches", "127.0.0.1"]]);
  assert.deepEqual(of({ ears: { stt_engine: "kyutai", stt_fallback_engine: "none" } }, "ears").map((e) => e.engine), ["kyutai"]);
  assert.deepEqual(of({ ears: { stt_engine: "openai", openai: { base_url: "" } } }, "ears"), [], "a blank base_url has no entry");
  assert.deepEqual(of({ ears: { stt_engine: "nemotron", stt_fallback_engine: "none", nemotron: { url: "" } } }, "ears"), []);
});

// @spec CFG-EGR-004, CFG-EGR-007
test("eyes has an entry of data frames for every provider but stub, whether or not vision.enabled, and openai at the default base_url is off the LAN", () => {
  process.env.OLLAMA_URL = "http://ollama:11434";
  for (const enabled of [false, true]) {
    const e = one({ vision: { model: "v", obs: {}, enabled } }, "eyes");
    assert.deepEqual([e.data, e.engine, e.host, e.offLan], ["frames", "ollama", "ollama", false], `enabled ${enabled}`);
  }
  assert.deepEqual(of({ vision: { model: "v", obs: {}, provider: "stub" } }, "eyes"), []);
  const o = one({ vision: { model: "v", obs: {}, provider: "openai" } }, "eyes");
  assert.deepEqual([o.engine, o.host, o.offLan], ["openai", "api.openai.com", true]);
  const local = one({ vision: { model: "v", obs: {}, provider: "openai" }, llm: { model: "m", embed_model: "e", openai: { base_url: "http://192.168.1.9:1234/v1" } } }, "eyes");
  assert.deepEqual([local.host, local.offLan], ["192.168.1.9", false]);
});

// @spec CFG-EGR-005
test("eyes and cortex entries for anthropic and bedrock carry no host, name the provider as hosted and are off the LAN", () => {
  for (const provider of ["anthropic", "bedrock"]) {
    const eyes = one({ vision: { model: "v", obs: {}, provider } }, "eyes");
    assert.deepEqual([eyes.data, eyes.host, eyes.hosted, eyes.offLan], ["frames", undefined, provider, true]);
    const cortex = one({ llm: { provider, model: "m", embed_model: "e" } }, "cortex");
    assert.deepEqual([cortex.data, cortex.host, cortex.hosted, cortex.offLan], ["text", undefined, provider, true]);
  }
});

// @spec CFG-EGR-006
test("cortex has an entry of data text for every llm.provider but mock: ollama at the urls.ollama() host, openai at llm.openai.base_url", () => {
  process.env.OLLAMA_URL = "http://ollama:11434";
  const o = one({}, "cortex");
  assert.deepEqual([o.data, o.engine, o.host, o.offLan], ["text", "ollama", "ollama", false]);
  const a = one({ llm: { provider: "openai", model: "m", embed_model: "e" } }, "cortex");
  assert.deepEqual([a.engine, a.host, a.offLan], ["openai", "api.openai.com", true]);
  const l = one({ llm: { provider: "openai", model: "m", embed_model: "e", openai: { base_url: "http://nas:1234/v1" } } }, "cortex");
  assert.deepEqual([l.host, l.offLan], ["nas", false]);
  assert.deepEqual(of({ llm: { provider: "mock", model: "m", embed_model: "e" } }, "cortex"), []);
});

// @spec CFG-EGR-008
test("an IPv4 loopback, private or link-local address, localhost, host.docker.internal, a dotless name and a .local name are on the LAN, and neighbours of those ranges are not", () => {
  for (const h of ["127.0.0.1", "127.255.0.9", "10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.255", "192.168.0.1", "192.168.255.255", "169.254.1.1",
    "localhost", "host.docker.internal", "tts", "stt-kyutai", "nas.local", "Printer.LOCAL"]) assert.equal(offLan(h), false, h);
  for (const h of ["8.8.8.8", "11.0.0.1", "172.15.255.255", "172.32.0.1", "192.167.1.1", "192.169.0.1", "169.253.1.1", "169.255.0.1", "100.64.0.1", "128.0.0.1",
    "api.openai.com", "example.com", "nas.local.example.com", "my.lan"]) assert.equal(offLan(h), true, h);
});

// @spec CFG-EGR-008, CFG-EGR-009
test("an IPv6 literal is judged with its URL brackets removed: ::1, fc00::/7 and fe80::/10 are on the LAN, other addresses are not", () => {
  for (const h of ["[::1]", "[fc00::1]", "[fdab:1::2]", "[fe80::1]", "[febf::1]"]) assert.equal(offLan(h), false, h);
  for (const h of ["[2001:db8::1]", "[2606:4700::1]", "[fec0::1]", "[fe00::1]", "[::2]", "[fb00::1]"]) assert.equal(offLan(h), true, h);
});

// @spec CFG-EGR-010
test("an IPv4-mapped IPv6 host is judged as the IPv4 address it carries, in dotted and in the hex form a URL parser produces", () => {
  for (const h of ["[::ffff:192.168.1.5]", "[::ffff:127.0.0.1]", "[::ffff:10.0.0.1]", "[::ffff:c0a8:105]"]) assert.equal(offLan(h), false, h);
  for (const h of ["[::ffff:8.8.8.8]", "[::ffff:808:808]", "[::ffff:172.32.0.1]"]) assert.equal(offLan(h), true, h);
});

// @spec CFG-EGR-011
test("a host equal to a network.lan host entry (any case), ending a suffix entry or inside a range entry is on the LAN, and every other host is not", () => {
  const lan = ["nas.example.com", ".ts.net", "100.64.0.0/10", "2001:db8::/32", "203.0.113.7"];
  for (const h of ["nas.example.com", "NAS.Example.COM", "box.tail1234.ts.net", "100.64.0.1", "100.127.255.255", "[2001:db8::5]", "203.0.113.7"]) assert.equal(offLan(h, lan), false, h);
  for (const h of ["other.example.com", "evilts.net", "100.128.0.1", "100.63.255.255", "[2001:db9::1]", "203.0.113.8", "example.com"]) assert.equal(offLan(h, lan), true, h);
  assert.equal(offLan("nas.example.com"), true, "without the entry the same host is off the LAN");
  assert.equal(offLan("nas.example.com", []), true);
});

// @spec CFG-EGR-011, CFG-EGR-012
test("a trailing dot on a host or a list entry is ignored, and a dot suffix or a name never matches an IP literal", () => {
  assert.equal(offLan("box.tail1234.ts.net.", [".ts.net"]), false, "trailing dot on the host");
  assert.equal(offLan("nas.example.com.", ["nas.example.com"]), false, "trailing dot on the host only");
  assert.equal(offLan("nas.example.com", ["nas.example.com."]), false, "trailing dot on the entry only");
  assert.equal(offLan("203.0.113.5", [".113.5"]), true, "a suffix entry is not matched against an IPv4 address");
  assert.equal(offLan("[2001:db8::5]", ["::5"]), true, "a name-form entry is not matched against an IPv6 address");
});

// @spec CFG-EGR-001
test("a destination whose URL has no host (localhost:1234/v1) gets its raw value as host and is off the LAN, without throwing", () => {
  const c = cfg({ voice: { engine: "openai", voice: "v", openai: { base_url: "https://api.openai.com/v1", model: "m" } } });
  c.voice.openai.base_url = "localhost:1234/v1";
  const e = egressDestinations(c).find((x) => x.service === "voice")!;
  assert.deepEqual([e.host, e.offLan], ["localhost:1234/v1", true]);
});

// @spec CFG-EGR-012
test("a host name is judged by its form alone: nothing is resolved, so a public name is off the LAN unless network.lan lists it", () => {
  const lookup = mock.method(dns, "lookup");
  const promisesLookup = mock.method(dns.promises, "lookup");
  const resolve4 = mock.method(dns, "resolve4");
  try {
    assert.equal(offLan("resolves-to-lan.example.com"), true);
    assert.equal(offLan("resolves-to-lan.example.com", ["resolves-to-lan.example.com"]), false);
    assert.equal(lookup.mock.callCount() + promisesLookup.mock.callCount() + resolve4.mock.callCount(), 0);
  } finally {
    mock.restoreAll();
  }
});

// @spec CFG-EGR-013
test("a stub engine, the mock chat provider and a blank value give no entry, so an all-stub config has none", () => {
  const none = entries({
    llm: { provider: "mock", model: "m", embed_model: "e" }, voice: { engine: "stub" }, ears: { stt_engine: "stub" },
    vision: { model: "", obs: {}, provider: "stub" },
  });
  assert.deepEqual(none, []);
});
