import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { outboxPath, writePersonalityOutbox } from "@cohost/config";
import { applyPersonalityOutbox } from "../src/index.js";
import { sandbox } from "./helpers.js";

// @spec STORE-OUT-002
test("the outbox is applied when the stored personality still hashes to its base, then deleted; with no outbox nothing happens", async () => {
  const sb = sandbox();
  const store = await sb.open();
  try {
    assert.deepEqual(applyPersonalityOutbox(store, sb.data), { applied: false, reason: "none" });
    const before = store.personality()!;
    const revision = store.revision();
    writePersonalityOutbox(before, `${before}\n## Learned\n- likes frogs\n`, sb.data);
    const r = applyPersonalityOutbox(store, sb.data);
    assert.equal(r.applied, true);
    assert.equal(store.personality(), `${before}\n## Learned\n- likes frogs\n`);
    assert.ok(store.revision() > revision);
    assert.equal(existsSync(outboxPath(sb.data)), false, "the outbox is deleted");
  } finally {
    store.close();
  }
});

// @spec STORE-OUT-002
test("when the personality changed after the pass read it, the outbox is kept and the result says the block was not applied", async () => {
  const sb = sandbox();
  const store = await sb.open();
  try {
    const before = store.personality()!;
    writePersonalityOutbox(before, `${before}\n## Learned\n- x\n`, sb.data);
    assert.equal(store.write({ personality: "# Edited by the owner\n" }).ok, true);
    const r = applyPersonalityOutbox(store, sb.data);
    assert.equal(r.applied, false);
    assert.ok(!r.applied && r.reason === "conflict" && /was not applied because the personality changed/.test(r.message));
    assert.equal(store.personality(), "# Edited by the owner\n");
    assert.equal(existsSync(outboxPath(sb.data)), true, "the outbox is kept");
  } finally {
    store.close();
  }
});
