/**
 * The same store contract against a real Postgres with the pgvector extension. Skipped unless
 * COHOST_TEST_DATABASE_URL is set (for example postgres://cohost:cohost@127.0.0.1:5432/cohost_test); it creates the
 * tables on first run and uses a fresh viewer key per test, so it can share a database across runs.
 */
import { after, test } from "node:test";
import { HashEmbedder } from "@cohost/llm";
import { testConfig, silentLog } from "@cohost/testing";
import { MemoryStore } from "../src/store.js";
import { registerStoreContract, T0, type Harness } from "./store-contract.js";

const url = process.env.COHOST_TEST_DATABASE_URL;
const REGULAR = 3;

if (!url) {
  test("MemoryStore against real Postgres (set COHOST_TEST_DATABASE_URL to run)", { skip: true }, () => {});
} else {
  process.env.DATABASE_URL = url;
  const stores: MemoryStore[] = [];
  let initialised = false;
  registerStoreContract("MemoryStore (postgres)", async (): Promise<Harness> => {
    let now = T0;
    const cfg = testConfig({ brain: { memory: { regular_messages: REGULAR } } }).brain.memory;
    const store = new MemoryStore(new HashEmbedder(), cfg, silentLog, undefined, () => now);
    stores.push(store);
    if (!initialised) { await store.init(); initialised = true; } // idempotent; a second store needs no init because the schema exists
    return { store, advance: (ms) => { now += ms; }, now: () => now };
  }, { regular_messages: REGULAR });
  after(async () => { await Promise.all(stores.map((s) => s.close())); });
}
