import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseVideoValue } from "../src/index.js";

const ID = "dQw4w9WgXcQ";

// @spec SHARED-VID-001, CHAT-YT-004
test("a bare eleven-character id is accepted, trimmed; ids may hold letters, digits, - and _", () => {
  assert.equal(parseVideoValue(ID), ID);
  assert.equal(parseVideoValue(`  ${ID}\n`), ID);
  assert.equal(parseVideoValue("a-B_c1D2e3F"), "a-B_c1D2e3F");
});

// @spec SHARED-VID-001, CHAT-YT-004
test("an id of the wrong length or with other characters is not a video id", () => {
  for (const v of ["", "   ", "short", "dQw4w9WgXcQx", "dQw4w9WgXc", "dQw4w9WgX.Q", "dQw4w9 WgXc"]) {
    assert.equal(parseVideoValue(v), undefined, JSON.stringify(v));
  }
});

// @spec SHARED-VID-001, CHAT-YT-005
test("watch, short, live, embed and pop-out chat URLs on the listed hosts give the id", () => {
  const forms = [
    `https://www.youtube.com/watch?v=${ID}`,
    `https://youtube.com/watch?v=${ID}`,
    `https://m.youtube.com/watch?v=${ID}`,
    `https://youtu.be/${ID}`,
    `https://www.youtube.com/live/${ID}`,
    `https://www.youtube.com/embed/${ID}`,
    `https://www.youtube.com/live_chat?v=${ID}`,
    `https://youtube.com/live_chat?v=${ID}&is_popout=1`,
  ];
  for (const f of forms) assert.equal(parseVideoValue(f), ID, f);
});

// @spec SHARED-VID-001, CHAT-YT-005
test("the scheme is optional, the host is compared case-insensitively and other query parameters are ignored", () => {
  assert.equal(parseVideoValue(`www.youtube.com/watch?v=${ID}`), ID);
  assert.equal(parseVideoValue(`youtu.be/${ID}`), ID);
  assert.equal(parseVideoValue(`https://WWW.YouTube.COM/watch?v=${ID}`), ID);
  assert.equal(parseVideoValue(`https://www.youtube.com/watch?list=PL1&v=${ID}&t=42s`), ID);
  assert.equal(parseVideoValue(`  https://youtu.be/${ID}?si=abc  `), ID);
});

// @spec SHARED-VID-001, CHAT-YT-005
test("a host that is not listed gives nothing, even with a well-formed id", () => {
  for (const v of [`https://example.com/watch?v=${ID}`, `https://notyoutube.com/watch?v=${ID}`, `https://youtube.com.evil.example/watch?v=${ID}`, `https://music.youtube.com/watch?v=${ID}`]) {
    assert.equal(parseVideoValue(v), undefined, v);
  }
});

// @spec SHARED-VID-001, CHAT-YT-006
test("channel URLs, playlists, search phrases and URLs with no video are unparseable", () => {
  for (const v of [
    "https://www.youtube.com/@somehandle",
    "https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv",
    "https://www.youtube.com/c/SomeName",
    "https://www.youtube.com/user/someone",
    "https://www.youtube.com/playlist?list=PLabcdefghijk",
    "https://www.youtube.com/watch",
    "https://www.youtube.com/watch?v=short",
    "my favourite stream",
    "not a url at all",
  ]) assert.equal(parseVideoValue(v), undefined, v);
});

// @spec SHARED-VID-002
test("no service reads a YouTube video value except through parseVideoValue: no id pattern of its own in any services/*/src", () => {
  const services = fileURLToPath(new URL("../../../services/", import.meta.url));
  const files: string[] = [];
  for (const svc of readdirSync(services)) {
    const src = `${services}${svc}/src`;
    if (!existsSync(src)) continue;
    for (const f of readdirSync(src, { recursive: true }) as string[]) if (f.endsWith(".ts")) files.push(`${src}/${f}`);
  }
  assert.ok(files.some((f) => f.includes("/services/chat/src/")), "the chat sources are scanned");
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    assert.ok(!/\[A-Za-z0-9_-\]\{11\}|live_chat\?v=|youtu\.be\//.test(text), `${file} parses a video value itself`);
  }
});
