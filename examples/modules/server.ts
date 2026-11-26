/**
 * A custom brain module served over HTTP, in TypeScript: the `kind: http` hook.
 *
 * Node's built-in modules only, so there is nothing to install:
 *
 *     mise run example:hook-server:ts -- [port]    # listens on :8900, or the port you give (0 = any free port)
 *
 * A copy outside the checkout runs as `node server.ts [port]`.
 *
 * It needs Node 22.18 or later, which runs a `.ts` file by stripping its types. Keep to
 * type annotations, `type` and `interface`; syntax that generates code (enums, parameter
 * properties) is not stripped and will not run.
 *
 * It answers exactly as examples/modules/server.py does: the same three routes, the same toy
 * judgements, a 404 for any other path and a 500 with the error text when a request is unusable.
 *
 *   POST /salience  {"events":[{"kind","text","mention","changed",...}], "arousal"}  ->  {"scores":[0..1, ...]}
 *   POST /affect    {"source","who","text","mention","valence","arousal"}            ->  {"valence_delta","arousal_delta"}
 *   POST /critic    {"text","emotion","reason","transcript"}                         ->  {"ok":true} | {"ok":true,"text","emotion"} | {"ok":false,"note"}
 *
 * Each handler has a tiny stand-in where a real model call would go.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

type Json = Record<string, unknown>;
type SalienceEvent = { kind: string; text: string; mention?: boolean; changed?: boolean };

/** A field the request must carry: a missing one throws, and the caller answers 500 naming it. */
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- the caller names the field's type: need<string>(req, "text")
function need<T>(req: Json, name: string): T {
  if (req[name] === undefined) throw new Error(`missing field: ${name}`);
  return req[name] as T;
}

// --- the stand-ins. Replace these bodies with your model. --------------------

const GAME_WORDS = /\b(boss|died|clutch|raid|gg|clip|pog)\b/i;

// #region salience
function salience(req: Json): Json { // @spec HOOK-EX-002
  // Which of these events deserve a reaction? Here: a toy that likes game words.
  const scores = need<SalienceEvent[]>(req, "events").map((e) => {
    let s = 0.15;
    if (e.kind === "speech") s = 0.9;
    else if (e.mention) s = 1.0;
    else if (e.kind === "vision") s = e.changed ? 0.3 : 0.0;
    if (GAME_WORDS.test(e.text)) s = Math.min(1.0, s + 0.25);
    return s;
  });
  return { scores };
}
// #endregion salience

function affect(req: Json): Json { // @spec HOOK-EX-003
  // How does this line move the mood? Here: a two-word lexicon. Yours: a sentiment model.
  const text = need<string>(req, "text").toLowerCase();
  const dv = text.includes("love") ? 0.2 : text.includes("hate") ? -0.2 : 0.0;
  const da = req.mention ? 0.25 : 0.05;
  return { valence_delta: dv, arousal_delta: da };
}

// #region critic
function critic(req: Json): Json { // @spec HOOK-EX-004
  // Should this line be said? Here: block anything with a URL, trim to one sentence.
  const text = need<string>(req, "text");
  if (text.toLowerCase().includes("http")) return { ok: false, note: "no links on air" }; // @spec HOOK-EX-009
  const first = text.trim().split(/(?<=[.!?])\s+/)[0]!;
  if (first === text) return { ok: true };
  return { ok: true, text: first, emotion: (req.emotion as string | undefined) || "neutral" }; // @spec HOOK-EX-010
}
// #endregion critic

const ROUTES: Record<string, (req: Json) => Json> = { "/salience": salience, "/affect": affect, "/critic": critic }; // @spec HOOK-EX-001

// --- plumbing -----------------------------------------------------------------

// The route is the path alone, so `/critic?debug=1` reaches the critic (HOOK-EX-008).
// An empty body reads as `{}` (HOOK-EX-006). Node answers requests concurrently, so a
// client that stalls mid-body never holds up the others (HOOK-EX-007).
const server = createServer((req, res) => { // @spec HOOK-EX-001, HOOK-EX-005, HOOK-EX-006, HOOK-EX-007, HOOK-EX-008
  const send = (code: number, obj: unknown) => {
    const data = JSON.stringify(obj);
    res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(data) });
    res.end(data);
  };
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  const fn = req.method === "POST" ? ROUTES[path] : undefined;
  if (!fn) {
    req.resume();
    return send(404, { error: "unknown module" });
  }
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    try {
      const raw = Buffer.concat(chunks).toString("utf8");
      send(200, fn(JSON.parse(raw || "{}") as Json));
    } catch (e) { // a bad answer just means the region uses its rules
      send(500, { error: e instanceof Error ? e.message : String(e) });
    }
  });
});

// @spec HOOK-EX-015
const port = Number(process.argv[2] ?? 8900);
server.listen(port, "0.0.0.0", () => {
  console.log(`listening on ${(server.address() as AddressInfo).port}`);
});
