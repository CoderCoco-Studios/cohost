import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDecipheriv, randomBytes } from "node:crypto";
import { readStateFile, stateAad, writeStateFile } from "../src/index.js";

const capture = () => {
  const lines: string[] = [];
  return { lines, log: { warn: (obj: unknown, m?: string) => { lines.push(`${JSON.stringify(obj)} ${m ?? ""}`); } } as never };
};

// @spec STORE-STATE-002
test("a state file is AES-256-GCM under the state key with AAD cohost/state/v1|<unit>|<file name>, mode 0600, written through a rename", () => {
  const dir = mkdtempSync(join(tmpdir(), "cohost-state-"));
  const file = join(dir, "vts-token.enc");
  const key = randomBytes(32);
  writeStateFile(file, "avatar", key, "plugin-token-123");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(dir), ["vts-token.enc"], "no temporary file left");
  const text = readFileSync(file, "utf8");
  assert.doesNotMatch(text, /plugin-token-123/);
  // Decrypting by hand with the stated AAD proves the format.
  const [, nonce, tag, ct] = text.trim().split(".").map((p, i) => (i === 0 ? Buffer.from(p) : Buffer.from(p, "base64url"))) as [Buffer, Buffer, Buffer, Buffer];
  const d = createDecipheriv("aes-256-gcm", key, nonce);
  d.setAAD(stateAad("avatar", "vts-token.enc"));
  d.setAuthTag(tag);
  assert.equal(Buffer.concat([d.update(ct), d.final()]).toString("utf8"), "plugin-token-123");
  assert.equal(readStateFile(file, "avatar", key), "plugin-token-123");
  // A new nonce on every write.
  writeStateFile(file, "avatar", key, "plugin-token-123");
  assert.notEqual(readFileSync(file, "utf8"), text);
});

// @spec STORE-STATE-002
test("a file that does not decrypt (another key, another unit, a renamed file, damage) counts as absent with one warning naming it; a missing file is absent silently", () => {
  const dir = mkdtempSync(join(tmpdir(), "cohost-state-"));
  const file = join(dir, "twitch-token.enc");
  const key = randomBytes(32);
  writeStateFile(file, "chat", key, "refresh-abc");
  for (const [f, unit, k] of [[file, "chat", randomBytes(32)], [file, "avatar", key]] as const) {
    const { lines, log } = capture();
    assert.equal(readStateFile(f, unit, k, log), undefined);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /twitch-token\.enc/);
    assert.doesNotMatch(lines[0]!, /refresh-abc/);
  }
  const moved = join(dir, "other.enc");
  renameSync(file, moved);
  assert.equal(readStateFile(moved, "chat", key, capture().log), undefined, "the file name is bound in");
  writeFileSync(moved, "plaintext token");
  assert.equal(readStateFile(moved, "chat", key, capture().log), undefined);
  const { lines, log } = capture();
  assert.equal(readStateFile(join(dir, "none.enc"), "chat", key, log), undefined);
  assert.deepEqual(lines, []);
  assert.throws(() => writeStateFile(file, "chat", Buffer.alloc(16), "x"), /32 bytes/);
});
