import { test } from "node:test";
import assert from "node:assert/strict";
import { readSection } from "../src/index.js";

// A token pasted into config.yaml under a map of credentials is ignored by the loader, and it must not come back from the
// settings read either: the section read carries the map's text only where the map holds no credential (MOD-CFG-005).

const PASTED = "tools:\n  servers:\n    home:\n      url: https://h.example/mcp\n      token: sk-LEAK-123\n";

// @spec MOD-CFG-005
test("a token pasted into config.yaml under tools.servers is in no key of the section read", () => {
  const read = readSection(PASTED, "tools", []);
  assert.equal(JSON.stringify(read).includes("sk-LEAK-123"), false);
  assert.equal(read.keys["servers"]?.raw, undefined, "the map's own text is not returned");
  assert.ok(read.keys["servers"], "the key itself is still listed");
});
