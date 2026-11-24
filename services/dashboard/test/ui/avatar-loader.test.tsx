// The avatar page's model handling without a GPU (DASH-BUILD-011): etag comparison, the loader URL filter, the model
// URL and the load state machine (versions, cancellation, failure, timeout, reports). Failing-first step of issue #218:
// the modules under test do not exist yet. The state machine is generic in the model it builds, so a fake stands in
// for the glTF loader and the 3D library.
import { test } from "node:test";
import assert from "node:assert/strict";
import { etagVersion, etagMatches } from "../../ui/src/avatar/etag";
import { isLoaderUrlAllowed, modelUrl } from "../../ui/src/avatar/loader-url";
import { createModelLoader, IDLE_TIMEOUT_MS, type ModelReport } from "../../ui/src/avatar/model-loader";
import { FakeClock } from "./helpers/fakes";

const flush = async (): Promise<void> => { for (let i = 0; i < 6; i++) await new Promise<void>((r) => setImmediate(r)); };

// @spec DASH-AVP-026
test("the etag is compared without its W/ prefix and its quotes", () => {
  assert.equal(etagVersion('W/"abc123"'), "abc123");
  assert.equal(etagVersion('"abc123"'), "abc123");
  assert.equal(etagVersion("abc123"), "abc123");
  assert.equal(etagMatches('W/"abc123"', "abc123"), true);
  assert.equal(etagMatches('"abc123"', "abc123"), true);
  assert.equal(etagMatches('W/"abc123"', "abc124"), false);
  assert.equal(etagMatches(null, "abc123"), false, "a response with no etag does not match");
  assert.equal(etagMatches('W/""', ""), false, "an empty etag never matches an empty version");
});

// @spec DASH-AVP-026
test("only the prefix and the outer quotes are removed: a quote or W/ inside the value stays", () => {
  assert.equal(etagVersion('W/"a"b"'), 'a"b');
  assert.equal(etagVersion('W/"W/x"'), "W/x");
  assert.equal(etagMatches('W/"abc"', "ABC"), false, "the comparison is case-sensitive");
});

// @spec DASH-AVP-008
test("the loader URL filter allows data: and blob: URLs and refuses every other", () => {
  assert.equal(isLoaderUrlAllowed("data:image/png;base64,AAAA"), true);
  assert.equal(isLoaderUrlAllowed("blob:http://localhost:3000/3c3b"), true);
  assert.equal(isLoaderUrlAllowed("DATA:image/png;base64,AAAA"), true, "scheme is case-insensitive");
  for (const u of ["http://evil.example/x.png", "https://evil.example/x.png", "//evil.example/x.png", "tex.png", "/avatar/model", "../x.png", "file:///etc/passwd", "ftp://h/x", "javascript:alert(1)", "ws://h/x", "", "  ", "about:blank", "filesystem:http://h/x", "data", "blob"]) {
    assert.equal(isLoaderUrlAllowed(u), false, JSON.stringify(u));
  }
});

// @spec DASH-AVP-008
test("the loader URL filter cannot be fooled by leading whitespace, control characters or a scheme split by them", () => {
  for (const u of [" http://evil.example/x", "\thttp://evil.example/x", "\nhttps://evil.example/x", "ht\ttp://evil.example/x", "\u0000http://evil.example/x", " data:text/html,<script>", "java\nscript:alert(1)"]) {
    assert.equal(isLoaderUrlAllowed(u), false, JSON.stringify(u));
  }
  assert.equal(isLoaderUrlAllowed("data:,x"), true);
});

// @spec DASH-AVP-004
test("the model URL is GET /avatar/model for the applied model and /avatar/models/<encoded name> for a preview draft", () => {
  assert.equal(modelUrl({ kind: "applied" }), "/avatar/model");
  assert.equal(modelUrl({ kind: "draft", name: "Aiko v2.vrm" }), "/avatar/models/Aiko%20v2.vrm");
});

// @spec DASH-AVP-004, DASH-AVP-036
test("a draft name can never change the path: dots, slashes, query and fragment characters stay inside one segment", () => {
  for (const name of ["..", ".", "a/b", "../model", "a?b=1", "a#b", "a%2fb", "a\\b", "%2e%2e", "a\u0000b", "é😀"]) {
    const u = new URL(modelUrl({ kind: "draft", name }), "http://localhost:3000");
    assert.equal(u.search, "", name);
    assert.equal(u.hash, "", name);
    assert.ok(u.pathname.startsWith("/avatar/models/"), `${name} -> ${u.pathname}`);
    assert.equal(u.pathname.split("/").length, 4, `${name} -> ${u.pathname}`);
    assert.notEqual(u.pathname.split("/")[3], "..");
    assert.notEqual(u.pathname.split("/")[3], ".");
  }
});

// ---- the load state machine ------------------------------------------------------------------------------------

interface Fake { id: number; bytes: ArrayBuffer; disposed: number }
interface Pending { url: string; signal: AbortSignal; bypassCache: boolean; respond(r: Response): void; reject(e: unknown): void }

function rig() {
  const clock = new FakeClock();
  const fetches: Pending[] = [];
  const reports: ModelReport[] = [];
  const built: Fake[] = [];
  const buildGate: { resolve: () => void }[] = [];
  let holdBuild = false;
  let failBuild: string | null = null;
  const loader = createModelLoader<Fake>({
    fetchModel: (url, opts) => new Promise<Response>((resolve, reject) => {
      const p: Pending = { url, signal: opts.signal, bypassCache: opts.bypassCache === true, respond: resolve, reject };
      opts.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      fetches.push(p);
    }),
    build: async (bytes, signal) => {
      if (holdBuild) await new Promise<void>((r) => buildGate.push({ resolve: r }));
      // No abort check here: a build that finishes after its request was superseded must be disposed by the loader.
      if (failBuild !== null) throw new Error(failBuild);
      const m: Fake = { id: built.length + 1, bytes, disposed: 0 };
      built.push(m);
      return m;
    },
    dispose: (m) => { m.disposed++; },
    report: (r) => reports.push(r),
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  const ok = (version: string, body = "glb"): Response => new Response(body, { status: 200, headers: { etag: `W/"${version}"` } });
  return {
    clock, fetches, reports, built, loader, ok,
    hold: (v: boolean) => { holdBuild = v; },
    failBuildWith: (m: string | null) => { failBuild = m; },
    releaseBuilds: () => { while (buildGate.length) buildGate.shift()!.resolve(); },
  };
}
const target = (version: string) => ({ url: "/avatar/model", version });
const states = (r: ReturnType<typeof rig>) => r.reports.map((x) => `${x.version}:${x.state}`);

// @spec DASH-AVP-023
test("a new model version is fetched, built and swapped in when ready; loading then ready are reported with the version", async () => {
  const r = rig();
  r.loader.request(target("v1"));
  assert.equal(r.fetches.length, 1);
  assert.equal(r.fetches[0]!.url, "/avatar/model");
  assert.equal(r.loader.loadingVersion(), "v1");
  assert.equal(r.loader.current(), null, "nothing is held while the first load runs");
  r.fetches[0]!.respond(r.ok("v1")); await flush();
  assert.equal(r.loader.current(), r.built[0]);
  assert.equal(r.loader.heldVersion(), "v1");
  assert.equal(r.loader.loadingVersion(), null);
  assert.deepEqual(states(r), ["v1:loading", "v1:ready"]);
});

// @spec DASH-AVP-023
test("the old model keeps drawing until the new one is ready, then is disposed once", async () => {
  const r = rig();
  r.loader.request(target("v1")); r.fetches[0]!.respond(r.ok("v1")); await flush();
  const old = r.built[0]!;
  r.loader.request(target("v2"));
  assert.equal(r.loader.current(), old, "no empty frame while the new model loads");
  assert.equal(old.disposed, 0);
  r.fetches[1]!.respond(r.ok("v2")); await flush();
  assert.equal(r.loader.current(), r.built[1]);
  assert.equal(old.disposed, 1);
  assert.equal(r.built[1]!.disposed, 0);
});

// @spec DASH-AVP-024
test("a request for the version already held or being loaded aborts and fetches nothing", async () => {
  const r = rig();
  r.loader.request(target("v1"));
  r.loader.request(target("v1"));
  assert.equal(r.fetches.length, 1);
  assert.equal(r.fetches[0]!.signal.aborted, false);
  r.fetches[0]!.respond(r.ok("v1")); await flush();
  r.loader.request(target("v1"));
  assert.equal(r.fetches.length, 1);
  assert.equal(r.loader.current(), r.built[0]);
});

// @spec DASH-AVP-024
test("a newer version aborts the fetch in flight; only the newest request finishes, a late older answer cannot win", async () => {
  const r = rig();
  r.loader.request(target("v1"));
  r.loader.request(target("v2"));
  assert.equal(r.fetches[0]!.signal.aborted, true);
  assert.equal(r.fetches[1]!.signal.aborted, false);
  r.fetches[0]!.respond(r.ok("v1")); // an answer that raced the abort
  r.fetches[1]!.respond(r.ok("v2")); await flush();
  assert.equal(r.loader.heldVersion(), "v2");
  assert.equal(r.built.length, 1, "the superseded response was never built");
  assert.deepEqual(states(r).filter((s) => s.endsWith(":ready")), ["v2:ready"]);
  assert.ok(!states(r).includes("v1:failed"), "a superseded load is not a failure");
});

// @spec DASH-AVP-024
test("a model half built when a newer request arrives is disposed and never swapped in", async () => {
  const r = rig();
  r.hold(true);
  r.loader.request(target("v1")); r.fetches[0]!.respond(r.ok("v1")); await flush();
  r.loader.request(target("v2")); // v1 is inside build()
  r.hold(false);
  r.releaseBuilds(); await flush();
  r.fetches[1]!.respond(r.ok("v2")); await flush();
  assert.equal(r.loader.heldVersion(), "v2");
  for (const m of r.built.filter((b) => b !== r.loader.current())) assert.equal(m.disposed, 1, `model ${m.id}`);
  assert.equal(r.built.filter((b) => b === r.loader.current()).length, 1);
});

// @spec DASH-AVP-024, DASH-AVP-036
test("three requests in a row finish only the last (the preview picking rows quickly)", async () => {
  const r = rig();
  r.loader.request({ url: "/avatar/models/a.vrm", version: "draft:a.vrm" });
  r.loader.request({ url: "/avatar/models/b.vrm", version: "draft:b.vrm" });
  r.loader.request({ url: "/avatar/models/c.vrm", version: "draft:c.vrm" });
  assert.deepEqual(r.fetches.map((f) => f.signal.aborted), [true, true, false]);
  r.fetches[2]!.respond(r.ok("draft:c.vrm")); await flush();
  assert.equal(r.loader.heldVersion(), "draft:c.vrm");
});

// @spec DASH-AVP-029
test("a failed load keeps drawing the previous model and reports failed with the reason", async () => {
  const r = rig();
  r.loader.request(target("v1")); r.fetches[0]!.respond(r.ok("v1")); await flush();
  const old = r.built[0]!;
  r.failBuildWith("unsupported extension KHR_draco");
  r.loader.request(target("v2")); r.fetches[1]!.respond(r.ok("v2")); await flush();
  assert.equal(r.loader.current(), old);
  assert.equal(old.disposed, 0);
  assert.equal(r.loader.heldVersion(), "v1");
  const last = r.reports.at(-1)!;
  assert.equal(last.state, "failed"); assert.equal(last.version, "v2");
  assert.match(last.detail, /KHR_draco/);
});

// @spec DASH-AVP-029
test("a failed first load leaves no model and reports failed; an HTTP error and a network error fail the same way", async () => {
  const r = rig();
  r.loader.request(target("v1"));
  r.fetches[0]!.respond(new Response("nope", { status: 404 })); await flush();
  assert.equal(r.loader.current(), null);
  assert.equal(r.reports.at(-1)!.state, "failed");
  assert.match(r.reports.at(-1)!.detail, /404/);
  r.loader.request(target("v2"));
  r.fetches[1]!.reject(new TypeError("Failed to fetch")); await flush();
  assert.equal(r.reports.at(-1)!.state, "failed");
  assert.equal(r.reports.at(-1)!.version, "v2");
  assert.equal(r.loader.loadingVersion(), null);
});

// @spec DASH-AVP-029
test("a failed version is tried again when the same version is requested later (a failure is not held as success)", async () => {
  const r = rig();
  r.failBuildWith("bad");
  r.loader.request(target("v1")); r.fetches[0]!.respond(r.ok("v1")); await flush();
  r.failBuildWith(null);
  r.loader.request(target("v1"));
  assert.equal(r.fetches.length, 2);
});

// @spec DASH-AVP-023
test("the failure detail is at most 200 characters and never splits a surrogate pair", async () => {
  const r = rig();
  r.failBuildWith("😀".repeat(300));
  r.loader.request(target("v1")); r.fetches[0]!.respond(r.ok("v1")); await flush();
  const d = r.reports.at(-1)!.detail;
  assert.ok([...d].length <= 200, String([...d].length));
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(d), "no lone surrogate");
  r.failBuildWith("x".repeat(500));
  r.loader.request(target("v2")); r.fetches[1]!.respond(r.ok("v2")); await flush();
  assert.equal(r.reports.at(-1)!.detail.length, 200);
});

// @spec DASH-AVP-026
test("a response whose etag differs from the view's version is fetched once more bypassing the cache, and that answer is used", async () => {
  const r = rig();
  r.loader.request(target("new"));
  assert.equal(r.fetches[0]!.bypassCache, false);
  r.fetches[0]!.respond(r.ok("old", "stale-bytes")); await flush();
  assert.equal(r.fetches.length, 2, "exactly one more fetch");
  assert.equal(r.fetches[1]!.url, "/avatar/model");
  assert.equal(r.fetches[1]!.bypassCache, true);
  assert.equal(r.loader.current(), null, "the stale bytes are not built while the refetch is pending");
  r.fetches[1]!.respond(r.ok("new", "fresh-bytes")); await flush();
  assert.equal(new TextDecoder().decode(r.built[0]!.bytes), "fresh-bytes");
  assert.equal(r.loader.heldVersion(), "new");
});

// @spec DASH-AVP-026
test("when the refetch still differs, the page uses what it returned and fetches no third time", async () => {
  const r = rig();
  r.loader.request(target("new"));
  r.fetches[0]!.respond(r.ok("old")); await flush();
  r.fetches[1]!.respond(r.ok("newer", "newest-bytes")); await flush();
  assert.equal(r.fetches.length, 2);
  assert.equal(new TextDecoder().decode(r.built[0]!.bytes), "newest-bytes");
  assert.equal(r.reports.at(-1)!.state, "ready");
});

// @spec DASH-AVP-026
test("a matching weak etag fetches once, and a response with no etag counts as different", async () => {
  const r = rig();
  r.loader.request(target("v1")); r.fetches[0]!.respond(r.ok("v1")); await flush();
  assert.equal(r.fetches.length, 1);
  r.loader.request(target("v2"));
  r.fetches[1]!.respond(new Response("glb", { status: 200 })); await flush();
  assert.equal(r.fetches.length, 3);
  assert.equal(r.fetches[2]!.bypassCache, true);
});

/** A response whose body the test feeds: `push` delivers bytes, `finish` ends it. */
function streaming(version: string): { response: Response; push(s: string): void; finish(): void } {
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(c) { ctl = c; } });
  return {
    response: new Response(body, { status: 200, headers: { etag: `W/"${version}"` } }),
    push: (s) => ctl.enqueue(new TextEncoder().encode(s)),
    finish: () => ctl.close(),
  };
}

// @spec DASH-AVP-027
test("a fetch that delivers no byte for 30 s is aborted and reported failed", async () => {
  const r = rig();
  assert.equal(IDLE_TIMEOUT_MS, 30_000);
  r.loader.request(target("v1"));
  const s = streaming("v1");
  r.fetches[0]!.respond(s.response); await flush();
  r.clock.tick(29_999); await flush();
  assert.equal(r.fetches[0]!.signal.aborted, false);
  r.clock.tick(1); await flush();
  assert.equal(r.fetches[0]!.signal.aborted, true);
  assert.equal(r.reports.at(-1)!.state, "failed");
  assert.match(r.reports.at(-1)!.detail, /30|timed out|stalled/i);
  assert.equal(r.loader.current(), null);
});

// @spec DASH-AVP-027
test("a stall before the response headers counts too, and each byte restarts the 30 s", async () => {
  const stalled = rig();
  stalled.loader.request(target("v1"));
  stalled.clock.tick(30_000); await flush();
  assert.equal(stalled.fetches[0]!.signal.aborted, true);
  assert.equal(stalled.reports.at(-1)!.state, "failed");

  const r = rig();
  r.loader.request(target("v1"));
  const s = streaming("v1");
  r.fetches[0]!.respond(s.response); await flush();
  r.clock.tick(20_000); s.push("a"); await flush();
  r.clock.tick(29_000); await flush();
  assert.equal(r.fetches[0]!.signal.aborted, false, "a byte at 20 s restarted the clock");
  s.push("b"); await flush();
  r.clock.tick(29_999); await flush();
  assert.equal(r.fetches[0]!.signal.aborted, false);
  s.finish(); await flush();
  assert.equal(r.loader.heldVersion(), "v1");
  assert.equal(r.clock.pending, 0, "no idle timer outlives the load");
});

// @spec DASH-AVP-027, DASH-AVP-029
test("a stalled load that fails keeps the previous model", async () => {
  const r = rig();
  r.loader.request(target("v1")); r.fetches[0]!.respond(r.ok("v1")); await flush();
  r.loader.request(target("v2"));
  r.clock.tick(30_000); await flush();
  assert.equal(r.loader.current(), r.built[0]);
  assert.equal(r.built[0]!.disposed, 0);
});

// @spec DASH-AVP-028
test("clear() (a null model) disposes what is held, aborts a load in flight and draws no model", async () => {
  const r = rig();
  r.loader.request(target("v1")); r.fetches[0]!.respond(r.ok("v1")); await flush();
  r.loader.request(target("v2"));
  r.loader.clear();
  assert.equal(r.fetches[1]!.signal.aborted, true);
  assert.equal(r.loader.current(), null);
  assert.equal(r.loader.heldVersion(), null);
  assert.equal(r.loader.loadingVersion(), null);
  assert.equal(r.built[0]!.disposed, 1);
  r.fetches[1]!.respond(r.ok("v2")); await flush();
  assert.equal(r.loader.current(), null, "the aborted v2 cannot reappear");
  r.loader.request(target("v1"));
  assert.equal(r.fetches.length, 3, "the same version after a clear is fetched again");
});

// @spec DASH-AVP-025
test("every model built is disposed exactly once however it ends: replaced, cleared or superseded", async () => {
  const r = rig();
  r.loader.request(target("v1")); r.fetches[0]!.respond(r.ok("v1")); await flush();
  r.loader.request(target("v2")); r.fetches[1]!.respond(r.ok("v2")); await flush();
  r.loader.request(target("v3")); r.fetches[2]!.respond(r.ok("v3")); await flush();
  r.loader.clear();
  assert.deepEqual(r.built.map((b) => b.disposed), [1, 1, 1]);
  r.loader.clear();
  assert.deepEqual(r.built.map((b) => b.disposed), [1, 1, 1], "a second clear disposes nothing again");
});

// @spec DASH-AVP-023
test("reports carry only the version, a state and a detail of at most 200 characters", async () => {
  const r = rig();
  r.loader.request(target("v1")); r.fetches[0]!.respond(r.ok("v1")); await flush();
  for (const rep of r.reports) {
    assert.deepEqual(Object.keys(rep).sort(), ["detail", "state", "version"]);
    assert.ok(rep.detail.length <= 200);
    assert.ok(JSON.stringify({ type: "model", ...rep }).length < 4096, "within the relay's 4096-byte message cap");
  }
});

// @spec DASH-AVP-024, DASH-AVP-025
test("a half-built model that finishes after a newer request is disposed and never swapped in", async () => {
  const r = rig();
  r.hold(true);
  r.loader.request(target("v1")); r.fetches[0]!.respond(r.ok("v1")); await flush();
  r.loader.request(target("v2"));
  r.hold(false);
  r.releaseBuilds(); await flush();
  assert.equal(r.built.length, 1, "the superseded v1 build finished");
  assert.equal(r.built[0]!.disposed, 1, "and was disposed");
  assert.equal(r.loader.current(), null, "nothing is swapped in for v1");
  r.fetches[1]!.respond(r.ok("v2")); await flush();
  assert.equal(r.loader.heldVersion(), "v2");
  assert.equal(r.built[1]!.disposed, 0);
});

// @spec DASH-AVP-027
test("the idle timer covers the transfer only: a build slower than 30 s after the last byte does not fail the load", async () => {
  const r = rig();
  r.hold(true);
  r.loader.request(target("v1"));
  const s = streaming("v1");
  r.fetches[0]!.respond(s.response); await flush();
  s.push("glb"); s.finish(); await flush();
  r.clock.tick(40_000); await flush();
  assert.equal(r.reports.at(-1)!.state, "loading", "still building, not failed");
  r.hold(false);
  r.releaseBuilds(); await flush();
  assert.equal(r.loader.heldVersion(), "v1");
  assert.equal(r.reports.at(-1)!.state, "ready");
});
