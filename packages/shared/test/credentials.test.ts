import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, openSync, renameSync, writeFileSync, closeSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkCredentialsMessage, receiveCredentials, CREDENTIALS_FD_ENV, MAX_CREDENTIALS_BYTES } from "../src/index.js";

const msg = (o: Record<string, unknown>): string => JSON.stringify({ format: 1, unit: "chat", revision: 3, credentials: {}, ...o });
const KEY = Buffer.alloc(32, 7).toString("base64url");

/** Writes a message the way the control plane does: a temporary file renamed into place. */
function deliver(dir: string, text: string): void {
  const tmp = join(dir, ".credentials.tmp");
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, join(dir, "credentials.json"));
}

function capture() {
  const lines: { obj: unknown; msg: string }[] = [];
  return { lines, log: { warn: (obj: unknown, m?: string) => { lines.push({ obj, msg: m ?? String(obj) }); } } as never };
}

// @spec STORE-DLV-004
test("a message is accepted only with format 1, the unit's own id, declared paths and a state key only where declared", () => {
  const ok = checkCredentialsMessage("chat", msg({ credentials: { "chat.twitch.client_id": "id-1" }, state_key: KEY }));
  assert.ok(ok.ok);
  assert.deepEqual(ok.value.credentials, { "chat.twitch.client_id": "id-1" });
  assert.equal(ok.value.revision, 3);
  assert.equal(ok.value.stateKey?.length, 32);

  const refuse = (unit: string, text: string, re: RegExp): void => {
    const r = checkCredentialsMessage(unit, text);
    assert.equal(r.ok, false, text);
    if (!r.ok) assert.match(r.reason, re);
  };
  refuse("chat", msg({ format: 2 }), /format is not 1/);
  refuse("chat", msg({ unit: "voice" }), /for voice, not chat/);
  refuse("chat", msg({ credentials: { "llm.openai.api_key": "sk-leak" } }), /does not declare: llm\.openai\.api_key/);
  refuse("chat", "not json", /not JSON/);
  refuse("chat", msg({ credentials: { "chat.twitch.client_id": "x".repeat(MAX_CREDENTIALS_BYTES) } }), /larger than/);
  refuse("voice", msg({ unit: "voice", state_key: KEY }), /state key, which voice does not declare/);
  refuse("chat", msg({ state_key: "short" }), /not 32 bytes/);
  refuse("chat", msg({ credentials: { "chat.twitch.client_id": "" } }), /not a non-empty string/);
  refuse("nobody", msg({ unit: "nobody" }), /not a unit of the manifest/);
  // A refusal names paths, never a value.
  const r = checkCredentialsMessage("chat", msg({ credentials: { "llm.openai.api_key": "sk-leak" } }));
  assert.ok(!r.ok && !r.reason.includes("sk-leak"));
  // The wildcard path matches each server's token; ears alone may carry the derived listener key.
  assert.ok(checkCredentialsMessage("tools", msg({ unit: "tools", credentials: { "tools.servers.docs.token": "t" } })).ok);
  assert.ok(checkCredentialsMessage("ears", msg({ unit: "ears", credentials: { "ears.http.verifier": "a".repeat(64) } })).ok);
  assert.ok(!checkCredentialsMessage("voice", msg({ unit: "voice", credentials: { "ears.http.verifier": "a".repeat(64) } })).ok);
});

// @spec SHARED-BOOT-010
test("receiveCredentials waits for /run/cohost/credentials.json, reads it, deletes it and resolves with the credentials", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cohost-run-"));
  const pending = receiveCredentials("chat", { dir, env: {}, recheckMs: 20 });
  let done = false;
  void pending.then(() => { done = true; });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(done, false, "it waits while no message is there");
  deliver(dir, msg({ credentials: { "chat.twitch.client_secret": "s3cret" } }));
  const got = await pending;
  assert.deepEqual(got.credentials, { "chat.twitch.client_secret": "s3cret" });
  assert.equal(existsSync(join(dir, "credentials.json")), false, "the file is deleted");
});

// @spec SHARED-BOOT-010
test("a refused message is logged with the reason, never a value, deleted and waited past until a corrected delivery", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cohost-run-"));
  const { lines, log } = capture();
  deliver(dir, msg({ unit: "voice", credentials: { "chat.twitch.client_secret": "wrong-unit-secret" } }));
  const pending = receiveCredentials("chat", { dir, env: {}, recheckMs: 20, log });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(lines.length, 1);
  assert.match(lines[0]!.msg, /refused the credentials message: the message is for voice, not chat/);
  assert.doesNotMatch(JSON.stringify(lines), /wrong-unit-secret/);
  deliver(dir, msg({ credentials: { "chat.twitch.client_secret": "right" } }));
  assert.deepEqual((await pending).credentials, { "chat.twitch.client_secret": "right" });
});

// @spec SHARED-BOOT-010
test("the wait finds a file written into a directory that did not exist when it began, by the timed look", async () => {
  const root = mkdtempSync(join(tmpdir(), "cohost-run-"));
  const dir = join(root, "later");
  const pending = receiveCredentials("chat", { dir, env: {}, recheckMs: 20 });
  await new Promise((r) => setTimeout(r, 30));
  const { mkdirSync } = await import("node:fs");
  mkdirSync(dir);
  deliver(dir, msg({}));
  assert.deepEqual((await pending).credentials, {});
});

// @spec SHARED-BOOT-010
test("a delivery renamed in after the file is claimed survives, and the next receive gets it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cohost-run-"));
  deliver(dir, msg({ credentials: { "chat.youtube.api_key": "first" } }));
  const first = await receiveCredentials("chat", {
    dir, env: {}, recheckMs: 20,
    onClaim: () => { deliver(dir, msg({ credentials: { "chat.youtube.api_key": "second" } })); },
  });
  assert.deepEqual(first.credentials, { "chat.youtube.api_key": "first" });
  assert.equal(existsSync(join(dir, "credentials.json")), true, "the later delivery is not deleted");
  assert.equal(existsSync(join(dir, ".credentials.claimed")), false, "the claimed file is deleted");
  assert.deepEqual((await receiveCredentials("chat", { dir, env: {}, recheckMs: 20 })).credentials, { "chat.youtube.api_key": "second" });
});

// @spec SHARED-BOOT-010
test("a delivered symbolic link, or a file over 64 KiB, is refused without being read and waited past", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cohost-run-"));
  const target = join(mkdtempSync(join(tmpdir(), "cohost-elsewhere-")), "secret.json");
  writeFileSync(target, msg({ credentials: { "chat.youtube.api_key": "via-link" } }));
  symlinkSync(target, join(dir, "credentials.json"));
  const { lines, log } = capture();
  const pending = receiveCredentials("chat", { dir, env: {}, recheckMs: 20, log });
  await new Promise((r) => setTimeout(r, 60));
  assert.match(lines[0]?.msg ?? "", /symbolic link/);
  writeFileSync(join(dir, ".big"), " ".repeat(MAX_CREDENTIALS_BYTES + 1));
  renameSync(join(dir, ".big"), join(dir, "credentials.json"));
  await new Promise((r) => setTimeout(r, 60));
  assert.match(lines[1]?.msg ?? "", /larger than/);
  deliver(dir, msg({ credentials: { "chat.youtube.api_key": "real" } }));
  assert.deepEqual((await pending).credentials, { "chat.youtube.api_key": "real" });
  assert.equal(existsSync(target), true, "the link's target is untouched");
});

// @spec SHARED-BOOT-010
test("an aborted wait rejects with the signal's reason", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cohost-run-"));
  const ac = new AbortController();
  const pending = receiveCredentials("chat", { dir, env: {}, recheckMs: 20, signal: ac.signal });
  ac.abort(new Error("shutting down"));
  await assert.rejects(pending, /shutting down/);
});

// @spec SHARED-BOOT-010, STORE-DLV-004
test("with COHOST_CREDENTIALS_FD set it reads that descriptor to its end; a refused message there rejects", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cohost-fd-"));
  const file = join(dir, "pipe");
  writeFileSync(file, msg({ credentials: { "chat.youtube.api_key": "yt" } }));
  const fd = openSync(file, "r");
  const got = await receiveCredentials("chat", { env: { [CREDENTIALS_FD_ENV]: String(fd) }, dir: join(dir, "unused") });
  assert.deepEqual(got.credentials, { "chat.youtube.api_key": "yt" });

  writeFileSync(file, msg({ unit: "voice" }));
  const fd2 = openSync(file, "r");
  await assert.rejects(receiveCredentials("chat", { env: { [CREDENTIALS_FD_ENV]: String(fd2) } }), /descriptor \d+ was refused: the message is for voice/);
  await assert.rejects(receiveCredentials("chat", { env: { [CREDENTIALS_FD_ENV]: "three" } }), /not a file descriptor number/);
  try { closeSync(fd2); } catch { /* closed by the stream */ }

  // A message on the descriptor past 64 KiB is refused unread past the limit, naming the size, never a value.
  writeFileSync(file, msg({ credentials: { "chat.youtube.api_key": "y".repeat(MAX_CREDENTIALS_BYTES) } }));
  const fd3 = openSync(file, "r");
  await assert.rejects(receiveCredentials("chat", { env: { [CREDENTIALS_FD_ENV]: String(fd3) } }), (e: Error) => {
    assert.match(e.message, new RegExp(`descriptor \\d+ was refused: the message is larger than ${MAX_CREDENTIALS_BYTES} bytes`));
    assert.doesNotMatch(e.message, /yyyy/);
    return true;
  });
  try { closeSync(fd3); } catch { /* closed by the stream */ }
});
