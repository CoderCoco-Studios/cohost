import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openStore, type Store, type StoreOptions } from "../src/index.js";
import type { CliIo } from "../src/cli/io.js";

export const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

// No test may reach the owner's real key file: every default key path points into a throwaway directory.
const guard = mkdtempSync(join(tmpdir(), "cohost-store-guard-"));
process.env.COHOST_KEY_FILE = join(guard, "master.key");

/** A throwaway data directory and key file, a notice sink and a warning sink. */
export interface Sandbox {
  data: string;
  keyFile: string;
  notices: string[];
  warnings: string[];
  opts: StoreOptions;
  open(extra?: StoreOptions): Promise<Store>;
}

/** A new sandbox; `tty` says whether the recovery-key notice sees a terminal. */
export function sandbox(tty = false): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "cohost-store-"));
  const notices: string[] = [];
  const warnings: string[] = [];
  const opts: StoreOptions = {
    dataDir: join(root, "data"),
    keyFile: join(root, "home", ".config", "cohost", "master.key"),
    seedDir: join(repo, "config"),
    notice: { isTTY: tty, write: (t) => { notices.push(t); } },
    warn: (m) => { warnings.push(m); },
  };
  return { data: opts.dataDir!, keyFile: opts.keyFile!, notices, warnings, opts, open: (extra = {}) => openStore({ ...opts, ...extra }) };
}

/** A scripted terminal: `hidden` and `typed` answer the prompts in order, `stdin` is standard input. */
export function fakeIo(o: { hidden?: string[]; typed?: string[]; stdin?: string; tty?: boolean } = {}): CliIo & { stdout: string; stderr: string } {
  const hidden = [...(o.hidden ?? [])];
  const typed = [...(o.typed ?? [])];
  const io = {
    stdout: "",
    stderr: "",
    out: (t: string) => { io.stdout += t; },
    err: (t: string) => { io.stderr += t; },
    stdoutIsTTY: o.tty ?? false,
    stdinIsTTY: o.tty ?? false,
    askHidden: async (_p: string) => hidden.shift() ?? "",
    ask: async (_p: string) => typed.shift() ?? "",
    readStdin: async () => o.stdin ?? "",
  };
  return io;
}
