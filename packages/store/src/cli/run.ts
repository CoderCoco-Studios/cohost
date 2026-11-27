import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseYaml, secretPathOf, stringifyYaml, unitsReadingSection, writeFileAtomic } from "@cohost/config";
import { exportStore, importPlan, MIN_PASSPHRASE_LENGTH, openSecrets, readExport, readParts, type ImportParts, type ImportPlan } from "../codec.js";
import { StoreError, type StoreIssue } from "../errors.js";
import { storeFile } from "../paths.js";
import { checkStore, moveDamagedAside, openStore, restoreBackup, sectionOf, type Store, type StoreOptions, type WriteResult } from "../store.js";
import { generateToken, MIN_TOKEN_LENGTH } from "../token.js";
import type { NoticeOut } from "../keys.js";
import type { CliIo } from "./io.js";

/** The commands of the `config:*` tasks (STORE-TASK-001), each `mise run config:<command> -- <arguments>`. */
export const COMMANDS = [
  "get", "set", "reset", "secret", "personality", "token", "key", "reset-credentials", "export", "import", "backup", "restore", "check",
] as const;

const USAGE = `usage: node packages/store/dist/cli/index.js <command> [arguments]
  get <path>                  the effective value of a setting; a credential prints set or not set
  set <path> <yaml value>     set one setting
  reset <path>                remove one setting so its default applies
  secret <path> [--clear]     set a credential read without echo (or from standard input), or clear it
  personality [--edit]        print the personality, or edit it in $EDITOR
  token [--stdin]             set the control token (generated, or read from standard input)
  key --show | --restore | --rotate | --confirm
  reset-credentials           delete every credential and generated key after a typed confirmation
  export [file] [--secrets]   write the settings (and, encrypted with a passphrase, the credentials) as YAML
  import <file> | --settings <yaml> --personality <md> --expressions <yaml> --secrets <yaml>  [--dry-run]
  backup                      take a backup of the store
  restore <file>              restore a backup into the store
  check                       list every problem that stops the store's use
`;

class Usage extends Error {}

const issueLines = (issues: readonly StoreIssue[]): string => issues.map((i) => `  ${i.path || "(store)"}: ${i.message}\n`).join("");

/** The message of a failed write, or undefined when it succeeded. */
function writeFailure(r: WriteResult): string | undefined {
  if (r.ok) return undefined;
  if (r.conflict) return `the store changed (revision ${r.revision}); nothing was changed\n`;
  return `nothing was changed:\n${issueLines(r.issues)}`;
}

/** Splits arguments into flags (`--name`, `--name value` for the flags in `valued`) and positionals. */
function parseArgs(args: readonly string[], valued: readonly string[] = []): { flags: Map<string, string | true>; rest: string[] } {
  const flags = new Map<string, string | true>();
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith("--")) { rest.push(a); continue; }
    const name = a.slice(2);
    if (valued.includes(name)) {
      const v = args[++i];
      if (v === undefined) throw new Usage(`--${name} needs a file`);
      flags.set(name, v);
    } else flags.set(name, true);
  }
  return { flags, rest };
}

const getIn = (root: unknown, segs: readonly string[]): unknown =>
  segs.reduce<unknown>((o, k) => (o && typeof o === "object" && !Array.isArray(o) ? (o as Record<string, unknown>)[k] : undefined), root);

/**
 * Runs one `config:*` task (STORE-TASK-001 to -006, STORE-KEY-007 to -010, STORE-TOK-001, STORE-IO-002 to -004): opens the store
 * with the rules of `openStore`, never prints a credential except where the command's purpose is to print one, and returns 0
 * on success and 1 with one message otherwise.
 */
// @spec STORE-TASK-002, STORE-TASK-003, STORE-TASK-004, STORE-TASK-005, STORE-TASK-006, STORE-TOK-001, STORE-KEY-007, STORE-KEY-008, STORE-KEY-009, STORE-IO-002, STORE-IO-003, STORE-IO-004
export async function runCli(argv: readonly string[], io: CliIo, opts: StoreOptions = {}): Promise<number> {
  const [command, ...args] = argv;
  // The recovery key goes to standard output only when it is a terminal; the pointer that replaces it goes to standard error.
  const notice: NoticeOut = { isTTY: io.stdoutIsTTY, write: (t: string) => io.out(t), warn: (t: string) => io.err(t) };
  const base: StoreOptions = { ...opts, notice, warn: opts.warn ?? ((m) => io.err(`${m}\n`)) };
  try {
    switch (command) {
      case "get": return await withStore(base, (s) => get(s, args, io));
      case "set": return await withStore(base, (s) => set(s, args, io));
      case "reset": return await withStore(base, (s) => reset(s, args, io));
      case "secret": return await withStore(base, (s) => secret(s, args, io));
      case "personality": return await withStore(base, (s) => personality(s, args, io));
      case "token": return await withStore(base, (s) => token(s, args, io));
      case "key": return await key(args, io, base);
      case "reset-credentials": return await resetCredentials(io, base);
      case "export": return await withStore(base, (s) => exportCmd(s, args, io));
      case "import": return await importCmd(args, io, base);
      case "backup": return await withStore(base, async (s) => { io.out(`backup written: ${await s.backup()}\n`); return 0; });
      case "restore": return await restore(args, io, base);
      case "check": return await check(io, base);
      default: throw new Usage(command === undefined ? "no command given" : `unknown command: ${command}`);
    }
  } catch (e) {
    if (e instanceof Usage) { io.err(`${e.message}\n${USAGE}`); return 1; }
    if (e instanceof StoreError) { io.err(`${e.message}\n${issueLines(e.issues)}`); return 1; }
    throw e;
  }
}

async function withStore(opts: StoreOptions, fn: (s: Store) => number | Promise<number>): Promise<number> {
  const s = await openStore(opts);
  try { return await fn(s); } finally { s.close(); }
}

const one = (args: readonly string[], what: string): string => {
  if (args.length !== 1 || args[0]!.startsWith("--")) throw new Usage(`expected ${what}`);
  return args[0]!;
};

// @spec STORE-TASK-002
function get(s: Store, args: readonly string[], io: CliIo): number {
  const path = one(args, "one setting path");
  if (secretPathOf(path) !== undefined) { io.out(`${s.secretPaths().includes(path) ? "set" : "not set"}\n`); return 0; }
  if (sectionOf(path) === undefined) throw new StoreError("usage", `${path} is not in a settings section of this build`);
  const segs = path.split(".");
  const value = getIn(s.config(), segs);
  if (value === undefined) throw new StoreError("usage", `${path} is not a setting of this build`);
  const stored = getIn(s.settingsTree(), segs) !== undefined;
  io.out(`${stored ? "" : "# default\n"}${stringifyYaml(value, { lineWidth: 0 })}`);
  return 0;
}

/** The units whose manifest entry declares the path's section, which apply a change at their next start (STORE-TASK-002). */
const appliesNote = (path: string): string => {
  const section = sectionOf(path) ?? path;
  const units = unitsReadingSection(section);
  return units.length === 0
    ? `no unit declares the ${section} section; the dashboard reads it\n`
    : `${units.join(", ")} apply it at their next start\n`;
};

// @spec STORE-TASK-002
function set(s: Store, args: readonly string[], io: CliIo): number {
  if (args.length !== 2) throw new Usage("expected a setting path and a YAML value");
  const [path, text] = args as [string, string];
  if (secretPathOf(path) !== undefined) throw new StoreError("usage", `${path} is a credential: set it with mise run config:secret -- ${path}`);
  let value: unknown;
  try { value = parseYaml(text); } catch { throw new StoreError("usage", `the value for ${path} is not valid YAML`); }
  const failed = writeFailure(s.setKey(path, value));
  if (failed) { io.err(failed); return 1; }
  io.out(`saved ${path}; ${appliesNote(path)}`);
  return 0;
}

// @spec STORE-TASK-002, STORE-RCV-002
function reset(s: Store, args: readonly string[], io: CliIo): number {
  const path = one(args, "one setting path");
  if (secretPathOf(path) !== undefined) throw new StoreError("usage", `${path} is a credential: clear it with mise run config:secret -- ${path} --clear`);
  const failed = writeFailure(s.resetKey(path));
  if (failed) { io.err(failed); return 1; }
  io.out(`reset ${path} to its default; ${appliesNote(path)}`);
  return 0;
}

// @spec STORE-TASK-003, STORE-SET-005
async function secret(s: Store, args: readonly string[], io: CliIo): Promise<number> {
  const { flags, rest } = parseArgs(args);
  const path = one(rest, "one credential path");
  if (secretPathOf(path) === undefined) throw new StoreError("usage", `${path} is not a credential path`);
  if (flags.has("clear")) {
    const failed = writeFailure(s.write({ secrets: { [path]: null } }));
    if (failed) { io.err(failed); return 1; }
    io.out(`cleared ${path}\n`);
    return 0;
  }
  const value = io.stdinIsTTY ? await io.askHidden(`${path}: `) : await io.readStdin();
  const failed = writeFailure(s.write({ secrets: { [path]: value } }));
  if (failed) { io.err(failed); return 1; }
  io.out(`saved ${path}; ${appliesNote(path)}`);
  return 0;
}

async function personality(s: Store, args: readonly string[], io: CliIo): Promise<number> {
  const { flags } = parseArgs(args);
  if (!flags.has("edit")) { io.out(s.personality() ?? ""); return 0; }
  const dir = mkdtempSync(join(tmpdir(), "cohost-personality-"));
  try {
    const file = join(dir, "personality.md");
    writeFileSync(file, s.personality() ?? "", { mode: 0o600 });
    const editor = process.env.EDITOR || "vi";
    const r = spawnSync("sh", ["-c", `${editor} "$1"`, "sh", file], { stdio: "inherit" });
    if (r.status !== 0) { io.err(`the editor exited with status ${r.status ?? "none"}; nothing was changed\n`); return 1; }
    const failed = writeFailure(s.write({ personality: readFileSync(file, "utf8") }));
    if (failed) { io.err(failed); return 1; }
    io.out("saved the personality\n");
    return 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// @spec STORE-TOK-001
async function token(s: Store, args: readonly string[], io: CliIo): Promise<number> {
  const { flags } = parseArgs(args);
  if (flags.has("stdin")) {
    const t = (await io.readStdin()).trim();
    if (t.length < MIN_TOKEN_LENGTH) throw new StoreError("usage", `the token read from standard input is shorter than ${MIN_TOKEN_LENGTH} characters; nothing was changed`);
    s.setToken(t);
    io.out("the control token is set; every browser session has ended\n");
    return 0;
  }
  const t = generateToken();
  s.setToken(t);
  io.out(`The control token is:\n\n  ${t}\n\nIt is shown once: keep it in a password manager. Every browser session has ended.\n`);
  return 0;
}

// @spec STORE-KEY-007, STORE-KEY-008, STORE-KEY-010
async function key(args: readonly string[], io: CliIo, opts: StoreOptions): Promise<number> {
  const { flags } = parseArgs(args);
  const chosen = ["show", "restore", "rotate", "confirm"].filter((f) => flags.has(f));
  if (chosen.length !== 1) throw new Usage("key takes one of --show, --restore, --rotate, --confirm");
  return withStore({ ...opts, keyOptional: chosen[0] === "restore" }, async (s) => {
    switch (chosen[0]) {
      case "show": io.out(`${s.recoveryKey()}\n`); return 0;
      case "confirm":
        io.out(`${s.recoveryKey()}\n`);
        s.confirmRecoveryKey();
        io.out("the recovery key is marked as saved\n");
        return 0;
      case "rotate":
        s.rotateKey(opts.notice!);
        io.out(`the master key was rotated; the old key file is kept beside ${s.keyFile} for backups taken before now\n`);
        return 0;
      default:
        s.restoreKey(await io.askHidden("recovery key: "));
        io.out(`the master key file ${s.keyFile} is restored\n`);
        return 0;
    }
  });
}

/** The answer `config:reset-credentials` needs typed before it deletes anything (STORE-KEY-009). */
export const RESET_CONFIRMATION = "delete credentials";

// @spec STORE-KEY-009
async function resetCredentials(io: CliIo, opts: StoreOptions): Promise<number> {
  return withStore({ ...opts, keyOptional: true }, async (s) => {
    const answer = await io.ask(`This deletes every stored credential and generated key of ${s.file}. Type "${RESET_CONFIRMATION}" to go on: `);
    if (answer.trim() !== RESET_CONFIRMATION) { io.err("nothing was changed\n"); return 1; }
    await s.resetCredentials(opts.notice!);
    io.out("every credential was deleted and a new master key made. ears has no listener key until the next bearer check that succeeds or the next mise run config:token.\n");
    return 0;
  });
}

async function passphraseTwice(io: CliIo): Promise<string> {
  const a = await io.askHidden(`passphrase (at least ${MIN_PASSPHRASE_LENGTH} characters): `);
  if (a.length < MIN_PASSPHRASE_LENGTH) throw new StoreError("usage", `the passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters long`);
  const b = await io.askHidden("the passphrase again: ");
  if (a !== b) throw new StoreError("usage", "the two passphrases differ");
  return a;
}

// @spec STORE-IO-002
async function exportCmd(s: Store, args: readonly string[], io: CliIo): Promise<number> {
  const { flags, rest } = parseArgs(args);
  if (rest.length > 1) throw new Usage("export takes at most one file");
  const text = exportStore(s, flags.has("secrets") ? { passphrase: await passphraseTwice(io) } : {});
  if (rest[0] === undefined) { io.out(text); return 0; }
  writeFileAtomic(resolve(rest[0]), text, { mode: 0o600 });
  io.out(`exported to ${resolve(rest[0])}\n`);
  return 0;
}

const PARTS = ["settings", "personality", "expressions", "secrets"] as const;

// @spec STORE-IO-003, STORE-IO-004, STORE-TASK-006
async function importCmd(args: readonly string[], io: CliIo, opts: StoreOptions, throwaway = false): Promise<number> {
  const { flags, rest } = parseArgs(args, PARTS);
  const parts = PARTS.filter((p) => flags.has(p));
  if ((rest.length === 1) === (parts.length > 0) || rest.length > 1) throw new Usage("import takes one export file, or the parts --settings, --personality, --expressions and --secrets");
  const read = (f: string): string => { try { return readFileSync(resolve(f), "utf8"); } catch { throw new StoreError("usage", `cannot read ${resolve(f)}`); } };
  const dryRun = flags.has("dry-run");
  // A dry run with no store yet creates nothing: it compares against a throwaway store, seeded as a new one would be, in a
  // temporary directory with its own key file.
  if (dryRun && !throwaway && !existsSync(storeFile(opts.dataDir))) {
    const tmp = mkdtempSync(join(tmpdir(), "cohost-dry-run-"));
    try {
      io.err(`there is no settings store at ${storeFile(opts.dataDir)} yet: comparing with a new, seeded store; nothing is created\n`);
      return await importCmd(args, io, { ...opts, dataDir: join(tmp, "data"), keyFile: join(tmp, "master.key"), notice: { isTTY: false, write: () => undefined, warn: () => undefined } }, true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  let plan: ImportPlan;
  let issues: StoreIssue[];
  if (rest[0] !== undefined) ({ plan, issues } = readExport(read(rest[0])));
  else {
    const texts: ImportParts = {};
    for (const p of parts) texts[p] = read(flags.get(p) as string);
    ({ plan, issues } = readParts(texts));
  }
  if (issues.length === 0 && plan.sealed) {
    const opened = openSecrets(plan.sealed, await io.askHidden("passphrase: "));
    issues.push(...opened.issues);
    plan.secrets = opened.values;
  }
  if (issues.length > 0) { io.err(`nothing was imported:\n${issueLines(issues)}`); return 1; }

  // A damaged store is never written: it is moved aside and a new, unseeded store takes the import (STORE-TASK-006).
  let s: Store;
  try {
    s = await openStore(opts);
  } catch (e) {
    if (!(e instanceof StoreError) || e.kind !== "damaged" || dryRun) throw e;
    io.err(`${e.message}\nmoved it aside as ${moveDamagedAside(opts.dataDir)}\n`);
    s = await openStore({ ...opts, seed: false });
  }
  try {
    const { result, summary } = await importPlan(s, plan, { dryRun });
    const failed = writeFailure(result);
    if (failed) { io.err(failed.replace("nothing was changed", "nothing was imported")); return 1; }
    const list = (label: string, xs: readonly string[]): string => (xs.length > 0 ? `${label}: ${xs.join(", ")}\n` : "");
    io.out(
      (dryRun ? "dry run, nothing written. The import would change:\n" : "imported:\n") +
      list("  added", summary.added) + list("  changed", summary.changed) + list("  removed", summary.removed) +
      list("  credentials set", summary.secretsSet) + list("  credentials removed", summary.secretsRemoved) +
      plan.notes.map((n) => `  note: ${n}\n`).join(""),
    );
    if (!dryRun && flags.has("secrets")) io.out(`delete ${resolve(flags.get("secrets") as string)} now: its credentials are in the store, encrypted\n`);
    return 0;
  } finally {
    s.close();
  }
}

// @spec STORE-TASK-005, STORE-TASK-006
async function restore(args: readonly string[], io: CliIo, opts: StoreOptions): Promise<number> {
  const file = resolve(one(args, "one backup file"));
  const revision = await restoreBackup(file, opts);
  io.out(`restored ${file}; the store's revision is now ${revision}\n`);
  return 0;
}

// @spec STORE-TASK-004
async function check(io: CliIo, opts: StoreOptions): Promise<number> {
  const problems = await checkStore(opts);
  if (problems.length === 0) { io.out("ok\n"); return 0; }
  for (const p of problems) io.err(`${p.cause}: ${p.path ? `${p.path}: ` : ""}${p.message}\n`);
  return 1;
}
