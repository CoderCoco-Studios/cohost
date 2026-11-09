import { testConfig } from "@cohost/testing";
import { InMemoryStore } from "../src/fake-store.js";
import { registerStoreContract, T0 } from "./store-contract.js";

const REGULAR = 3;
registerStoreContract("InMemoryStore", async () => {
  let now = T0;
  const cfg = testConfig({ brain: { memory: { store: "memory", embedder: "hash", regular_messages: REGULAR } } }).brain.memory;
  const store = new InMemoryStore(cfg, () => now);
  return { store, advance: (ms) => { now += ms; }, now: () => now };
}, { regular_messages: REGULAR });
