#!/usr/bin/env node
// Writes the hook reply JSON Schemas (packages/modules/src/schemas.ts) to examples/modules/schemas/.
// Run after `pnpm build`:  node scripts/gen-hook-schemas.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HOOK_REPLY_SCHEMAS } from "../packages/modules/dist/schemas.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(root, "examples/modules/schemas");
mkdirSync(dir, { recursive: true });
for (const [name, schema] of Object.entries(HOOK_REPLY_SCHEMAS)) {
  writeFileSync(path.join(dir, `${name}.json`), `${JSON.stringify(schema, null, 2)}\n`);
  console.log(`wrote examples/modules/schemas/${name}.json`);
}
