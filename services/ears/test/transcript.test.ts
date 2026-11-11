import { test } from "node:test";
import assert from "node:assert/strict";
import { hasWordCharacter, isDropPhrase } from "../src/transcript.js";

// @spec EARS-HEAR-006, EARS-HEAR-007
test("hasWordCharacter: a Unicode letter or number in any script counts; punctuation and space do not", () => {
  for (const t of ["hello", "x", "7", "こんにちは", "Привет", "naïve", "  ...ü!! ", "٣"]) assert.equal(hasWordCharacter(t), true, t);
  for (const t of ["", "   ", "...", "!?—", "♪ ♪", "\n"]) assert.equal(hasWordCharacter(t), false, t);
});

// @spec EARS-HEAR-010
test("isDropPhrase: whole-transcript match, case-, space- and edge-punctuation-insensitive", () => {
  const phrases = ["Thank you.", "  thanks   for WATCHING!  "];
  assert.equal(isDropPhrase("thank you", phrases), true);
  assert.equal(isDropPhrase("  THANK YOU!!! ", phrases), true);
  assert.equal(isDropPhrase("...Thanks for   watching", phrases), true);
  assert.equal(isDropPhrase("thank you so much", phrases), false);
  assert.equal(isDropPhrase("well thank you", phrases), false);
  assert.equal(isDropPhrase("thank you", []), false);
  assert.equal(isDropPhrase("thank you", ["...", ""]), false, "an entry with nothing to compare never matches");
  assert.equal(isDropPhrase("Gracias.", ["gracias"]), true);
});
