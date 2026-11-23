import { testConfig } from "@cohost/testing";
import { InMemoryStore } from "../src/fake-store.js";
import { registerStoreContract, T0 } from "./store-contract.js";

const REGULAR = 3;
registerStoreContract("InMemoryStore", async () => {
  let now = T0;
  const cfg = testConfig({ brain: { memory: { store: "memory", embedder: "hash", regular_messages: REGULAR } } }).brain.memory;
  const store = new InMemoryStore(cfg, () => now);
  return {
    store,
    advance: (ms) => { now += ms; },
    now: () => now,
    // The rows as stored, with the chat ids (undefined when absent), read through the store's own row listing.
    memories: async (text) => (await store.recentSince({ ts: new Date(0).toISOString(), id: 0 }, 1_000_000))
      .filter((m) => m.text.includes(text))
      .map((m) => ({ kind: m.kind, text: m.text, platform: m.platform, userId: m.userId, messageId: m.messageId })),
  };
}, { regular_messages: REGULAR });
