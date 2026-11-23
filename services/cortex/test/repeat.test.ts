import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isRepeat } from "../src/repeat.js";

const T = 0.8;
const said = (text: string, extra: { heard?: string; fallback?: string } = {}) => ({ text, ...extra });

// @spec CTX-REPEAT-005, CTX-REPEAT-007
test("isRepeat: a word set is lower-cased, in-word apostrophes removed, L/M/N runs, each distinct word once", () => {
  const table: [string, string, boolean][] = [
    ["Hello World", "hello world", true], // case
    ["hello, world!!", "hello world", true], // punctuation separates and is dropped
    ["hello hello hello world", "hello world", true], // distinct words once
    ["don't", "dont", true], // U+0027 removed inside a word
    ["don’t", "dont", true], // U+2019 removed inside a word
    ["don't", "don t", false], // removed, not a separator: "dont" vs {"don","t"}
    ["rock-n-roll", "rock n roll", true], // other punctuation separates
    ["room 101", "ROOM 101", true], // N category
    ["café", "café", true], // M category stays inside the word
    ["TITLE", "title", true], // toLowerCase() with no locale: "I" folds to "i", not the Turkish dotless i
  ];
  for (const [a, b, want] of table) assert.equal(isRepeat(a, [said(b)], T), want, `${a} | ${b}`);
});

// @spec CTX-REPEAT-006
test("isRepeat: two empty word sets are never a repeat", () => {
  assert.equal(isRepeat("...", [said("!!!")], T), false);
  assert.equal(isRepeat("", [said("")], T), false);
  assert.equal(isRepeat("   ", [said("?")], 0.1), false);
});

// @spec CTX-REPEAT-007
test("isRepeat: under three words only equal, non-empty word sets repeat, whatever the threshold", () => {
  const table: [string, string, boolean][] = [
    ["ok cool", "cool ok", true],
    ["ok cool", "ok", false],
    ["ok cool", "ok cool wow", false], // one side has three words: still the short-line rule
    ["ok cool wow", "ok cool", false],
    ["ok cool", "ok cool", true],
    ["wow", "WOW!", true],
    ["wow", "", false], // one empty set against a non-empty one
  ];
  for (const [a, b, want] of table) assert.equal(isRepeat(a, [said(b)], 0.01), want, `${a} | ${b}`);
});

// @spec CTX-REPEAT-008
test("isRepeat: three words or more compare by Jaccard, a repeat at or above the threshold", () => {
  const a = "one two three four five";
  // 4 shared of 6 distinct: 4/6
  assert.equal(isRepeat(a, [said("one two three four six")], 4 / 6), true, "equal to the threshold is a repeat");
  assert.equal(isRepeat(a, [said("one two three four six")], 4 / 6 + 0.01), false);
  assert.equal(isRepeat(a, [said("one two three four six")], 0.5), true);
  assert.equal(isRepeat(a, [said("six seven eight nine ten")], 0.1), false, "disjoint");
  assert.equal(isRepeat(a, [said(a.toUpperCase())], 1), true, "identical sets meet a threshold of 1");
  assert.equal(isRepeat("a b c", [said("a b c d")], 0.8), false, "3 of 4 is 0.75");
  assert.equal(isRepeat("a b c", [said("a b c d")], 0.75), true);
});

// @spec CTX-REPEAT-008
test("isRepeat: word order and repeated words do not matter, only the sets", () => {
  assert.equal(isRepeat("red green blue", [said("blue blue green red red")], 1), true);
});

// @spec CTX-REPEAT-003
test("isRepeat: a recent line is its heard text, else its fallback text, else its text", () => {
  const meant = "completely different words about something else entirely";
  const reply = "see you all tomorrow night friends";
  assert.equal(isRepeat(reply, [said(meant, { heard: reply })], T), true, "heard wins over the text");
  assert.equal(isRepeat(reply, [said(reply, { heard: "no overlap whatsoever here today" })], T), false, "heard wins over the text, both ways");
  assert.equal(isRepeat(reply, [said(meant, { fallback: reply })], T), true, "fallback wins over the text");
  assert.equal(isRepeat(reply, [said(reply, { fallback: "an unrelated fallback sentence for sure" })], T), false);
  assert.equal(isRepeat(reply, [said(meant, { heard: "x y z w v u", fallback: reply })], T), false, "heard wins over the fallback");
  assert.equal(isRepeat(reply, [said(reply)], T), true, "neither: the text as meant");
});

// @spec CTX-REPEAT-004
test("isRepeat: a line with an empty heard text is left out of the check", () => {
  const reply = "see you all tomorrow night friends";
  assert.equal(isRepeat(reply, [said(reply, { heard: "" })], T), false);
  assert.equal(isRepeat(reply, [said(reply, { heard: "", fallback: reply })], T), false, "empty heard also beats a fallback");
  assert.equal(isRepeat(reply, [said(reply, { heard: "" }), said(reply)], T), true, "the other lines still count");
});

// @spec CTX-REPEAT-002, CTX-REPEAT-014
test("isRepeat: a reply is checked against every recent line; an empty window finds no repeat", () => {
  const reply = "see you all tomorrow night friends";
  assert.equal(isRepeat(reply, [said("one"), said("two"), said(reply)], T), true, "any line");
  assert.equal(isRepeat(reply, [said("one two three"), said("four five six")], T), false);
  assert.equal(isRepeat(reply, [], T), false);
  assert.equal(isRepeat("ok", [], T), false);
});

// @spec CTX-REPEAT-009
test("isRepeat: a threshold of 0 runs no check, even against an identical line", () => {
  assert.equal(isRepeat("see you all tomorrow night friends", [said("see you all tomorrow night friends")], 0), false);
  assert.equal(isRepeat("ok", [said("ok")], 0), false);
});

// @spec CTX-REPEAT-015
test("repeat.ts imports no runtime module and touches no I/O or clock", () => {
  const src = readFileSync(new URL("../src/repeat.ts", import.meta.url), "utf8");
  const imports = [...src.matchAll(/^\s*import\s+(?!type\b)[^;]*;/gm)].map((m) => m[0]);
  assert.deepEqual(imports, [], "only `import type` is allowed");
  assert.doesNotMatch(src, /\b(fetch|Date\.now|Math\.random|process\.|require\()|node:/);
});
