import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { outboxPath, readPersonalityOutbox, writePersonalityOutbox } from "@cohost/config";
import { applyPersonalityOutbox, type OutboxStore } from "../src/index.js";
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

// @spec STORE-OUT-002
test("a store write between the revision read and the apply is a conflict: nothing is written and the outbox is kept", async () => {
  const sb = sandbox();
  const store = await sb.open();
  try {
    const before = store.personality()!;
    writePersonalityOutbox(before, `${before}\n## Learned\n- y\n`, sb.data);
    const racing: OutboxStore = {
      revision: () => store.revision(),
      write: (c, o) => store.write(c, o),
      // Another writer commits after the applier took the revision and read the personality.
      personality: () => { const p = store.personality(); assert.equal(store.setKey("llm.temperature", 1.1).ok, true); return p; },
    };
    const r = applyPersonalityOutbox(racing, sb.data);
    assert.ok(!r.applied && r.reason === "conflict" && /settings store changed/.test(r.message), JSON.stringify(r));
    assert.equal(store.personality(), before, "nothing written");
    assert.equal(existsSync(outboxPath(sb.data)), true, "the outbox is kept for the next try");
    assert.deepEqual(readdirSync(join(sb.data, "memory")), ["personality-outbox.json"], "no claimed file left behind");
    assert.equal(applyPersonalityOutbox(store, sb.data).applied, true, "the next try applies it");
  } finally {
    store.close();
  }
});

// @spec STORE-OUT-002
test("an outbox a later pass writes while one is being applied survives the apply", async () => {
  const sb = sandbox();
  const store = await sb.open();
  try {
    const before = store.personality()!;
    writePersonalityOutbox(before, `${before}\n## Learned\n- first\n`, sb.data);
    const newer: OutboxStore = {
      revision: () => store.revision(),
      write: (c, o) => store.write(c, o),
      personality: () => { const p = store.personality()!; writePersonalityOutbox(p, `${p}\n## Learned\n- second\n`, sb.data); return p; },
    };
    assert.equal(applyPersonalityOutbox(newer, sb.data).applied, true);
    assert.equal(store.personality(), `${before}\n## Learned\n- first\n`);
    assert.equal(readPersonalityOutbox(sb.data)!.text, `${before}\n## Learned\n- second\n`, "the newer outbox is still there");
  } finally {
    store.close();
  }
});

// @spec STORE-OUT-002
test("a corrupt outbox is reported invalid, not thrown, and kept", async () => {
  const sb = sandbox();
  const store = await sb.open();
  try {
    writePersonalityOutbox("x", "y", sb.data);
    writeFileSync(outboxPath(sb.data), "{not json");
    const r = applyPersonalityOutbox(store, sb.data);
    assert.ok(!r.applied && r.reason === "invalid" && /is not a personality outbox/.test(r.message), JSON.stringify(r));
    assert.equal(readFileSync(outboxPath(sb.data), "utf8"), "{not json");
  } finally {
    store.close();
  }
});
