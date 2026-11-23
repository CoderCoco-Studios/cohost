import { test } from "node:test";
import assert from "node:assert/strict";
import { ISOLATION_ENV, ISOLATION_OVERRIDES } from "@cohost/config";
import { ComposeRuntime, SERVICE_MANIFEST, type ExecFile } from "../src/index.js";

const hasDocker = (name: string) => name === "docker";

// @spec CTRL-RUNTIME-009
test("compose: chat's isolated start sets only COHOST_ISOLATION, carrying {CHAT_SOURCES:[fake]}, and no CHAT_SOURCES or CHAT_SOURCE variable", async () => {
  const calls: { env: NodeJS.ProcessEnv }[] = [];
  const exec: ExecFile = async (_file, _args, opts) => { calls.push({ env: opts.env }); return { stdout: "", stderr: "" }; };
  const chat = SERVICE_MANIFEST.find((s) => s.id === "chat")!;
  assert.deepEqual(chat.isolatedEnv, { CHAT_SOURCES: "[fake]" });
  const rt = new ComposeRuntime({ onPath: hasDocker, exec, env: {} });
  assert.deepEqual(await rt.start("chat", { env: chat.isolatedEnv }), { ok: true });
  assert.equal(calls.length, 1);
  const env = calls[0]!.env;
  assert.deepEqual(JSON.parse(env[ISOLATION_ENV]!), { CHAT_SOURCES: "[fake]" });
  for (const name of [...Object.keys(ISOLATION_OVERRIDES), "CHAT_SOURCES", "CHAT_SOURCE"]) assert.equal(env[name], undefined, `${name} is set on no process`);
});
