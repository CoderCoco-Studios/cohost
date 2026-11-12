import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import type http from "node:http";
import { BodyTooLarge, readBody, readText } from "../src/body.js";

const req = (chunks: string[], headers: Record<string, string> = {}) => Object.assign(Readable.from(chunks.map((c) => Buffer.from(c))), { headers }) as unknown as http.IncomingMessage;

// @spec DASH-HTTP-015
test("readBody returns the bytes up to the cap and flags a larger body, draining the rest", async () => {
  assert.deepEqual(await readBody(req(["ab", "cd"]), 4), { data: Buffer.from("abcd"), tooLarge: false });
  assert.deepEqual(await readBody(req(["abc", "de"]), 4), { data: Buffer.alloc(0), tooLarge: true });
  assert.deepEqual(await readBody(req(["x"], { "content-length": "99" }), 4), { data: Buffer.alloc(0), tooLarge: true }, "declared length over the cap");
});

// @spec DASH-HTTP-015
test("readText gives the body as text, up to 64 KiB, and throws BodyTooLarge past it", async () => {
  assert.equal(await readText(req(["héllo"])), "héllo");
  await assert.rejects(readText(req(["x".repeat(64 * 1024 + 1)])), BodyTooLarge);
  assert.equal((await readText(req(["x".repeat(64 * 1024)]))).length, 64 * 1024);
});

// @spec DASH-HTTP-015
test("the routes, inject and viewers modules read bodies only through body.ts", () => {
  for (const f of ["routes", "inject", "viewers"]) {
    const src = readFileSync(new URL(`../src/${f}.ts`, import.meta.url), "utf8");
    assert.doesNotMatch(src, /req\.on\(\s*"data"/, `${f}.ts reads the request stream itself`);
  }
});
