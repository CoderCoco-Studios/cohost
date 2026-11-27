#!/usr/bin/env node
/**
 * The unit runner (settings-store STORE-DLV-007): `node packages/control/dist/run-unit.js <unit> [entry]`. How every host-run
 * service and one-shot starts (`mise run dev:<service>`, `reflect`, `consolidate`, `reembed`): it opens the settings store,
 * writes the unit's projection, starts `node <entry>` with the service directory as working directory, `CONFIG_DIR` set to
 * the projection directory and, when the unit gets a credentials message, `COHOST_CREDENTIALS_FD=3` and a pipe on descriptor 3
 * that carries the message and is then closed. It forwards SIGINT and SIGTERM and exits with the child's status. After a
 * `reflect` child exits 0 it applies the personality outbox (STORE-OUT-002).
 */
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { join, resolve } from "node:path";
import { findWorkspaceRoot, setLoggingSource, unitSettings } from "@cohost/config";
import {
  applyPersonalityOutbox, credentialsMessage, messageText, openStore, personalityUnits, projectionDir, writeProjections, type Store, type StoreOptions,
} from "@cohost/store";
import { controlTokenRefusal } from "./provision.js";

export interface RunUnitOptions {
  /** The workspace root (default: found from the working directory). */
  root?: string;
  /** The environment the child starts from (default `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** How the store is opened (tests: a sandbox). */
  store?: StoreOptions;
  spawn?: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess;
  /** Where a line for the owner goes (default standard error). */
  err?: (line: string) => void;
  /** Signal forwarding; the process's own by default. */
  onSignal?: (signal: NodeJS.Signals, fn: () => void) => void;
}

export const RUN_UNIT_USAGE = "usage: node packages/control/dist/run-unit.js <unit> [entry]";

/** Whether `entry` is the reflection pass, whose clean exit applies the personality outbox. */
const isReflect = (entry: string): boolean => /(^|[\\/])reflect\.js$/.test(entry);

/**
 * Runs `unit`'s `entry` (default `services/<unit>/dist/index.js`) as STORE-DLV-007 says. Resolves with the exit status: the
 * child's, 1 when the store, the projection or the start fails (one line naming the reason, never a value), 2 for usage.
 */
// @spec STORE-DLV-007, STORE-DLV-001, STORE-OUT-002, STORE-PKG-003, DEPLOY-TOOL-014
export async function runUnit(argv: readonly string[], o: RunUnitOptions = {}): Promise<number> {
  const err = o.err ?? ((l: string) => { process.stderr.write(`${l}\n`); });
  const [unit, entryArg, ...rest] = argv;
  const def = unit === undefined ? undefined : unitSettings(unit);
  if (unit === undefined || rest.length > 0) { err(RUN_UNIT_USAGE); return 2; }
  if (def === undefined || (def.config.length === 0 && def.documents.length === 0)) { err(`run-unit: ${unit} is not a unit that runs on the host`); return 2; }
  const root = o.root ?? findWorkspaceRoot() ?? process.cwd();
  const env = o.env ?? process.env;
  const refusal = controlTokenRefusal(env);
  if (refusal) { err(`run-unit: ${refusal}`); return 1; }
  const entry = resolve(root, entryArg ?? join("services", unit, "dist", "index.js"));

  let store: Store;
  try {
    store = await openStore({ ...o.store, profile: "other" });
  } catch (e) {
    err(`run-unit: ${(e as Error).message}`);
    return 1;
  }
  setLoggingSource(() => store.sections().logging);
  let message: string | undefined;
  try {
    writeProjections(store, root, [def]);
    const m = credentialsMessage(store, def.id);
    message = m === undefined ? undefined : messageText(m);
  } catch (e) {
    err(`run-unit: the projection of ${unit} could not be written: ${(e as Error).message}`);
    store.close();
    return 1;
  }

  const childEnv: NodeJS.ProcessEnv = { ...env, CONFIG_DIR: projectionDir(root, def.composeName) };
  if (message !== undefined) childEnv.COHOST_CREDENTIALS_FD = "3";
  else delete childEnv.COHOST_CREDENTIALS_FD;
  const spawn = o.spawn ?? nodeSpawn;
  const child = spawn(process.execPath, [entry], {
    cwd: join(root, "services", unit),
    env: childEnv,
    stdio: message !== undefined ? ["inherit", "inherit", "inherit", "pipe"] : "inherit",
  });
  if (message !== undefined) {
    const pipe = child.stdio[3] as NodeJS.WritableStream | null | undefined;
    pipe?.on?.("error", () => { /* the child exited before reading: its status reports it */ });
    pipe?.end(message);
  }
  const onSignal = o.onSignal ?? ((s: NodeJS.Signals, fn: () => void) => { process.on(s, fn); });
  for (const s of ["SIGINT", "SIGTERM"] as const) onSignal(s, () => { child.kill(s); });
  const status = await new Promise<number>((done) => {
    child.on("error", (e) => { err(`run-unit: cannot start ${entry}: ${e.message}`); done(1); });
    child.on("exit", (code, signal) => { done(code ?? (signal ? 128 + (signalNumber(signal) ?? 0) : 1)); });
  });

  if (status === 0 && isReflect(entry)) {
    try {
      const r = applyPersonalityOutbox(store, store.dataDir);
      if (r.applied) writeProjections(store, root, personalityUnits());
      else if (r.reason !== "none") err(`run-unit: ${r.message}`);
    } catch (e) {
      err(`run-unit: the personality outbox could not be applied: ${(e as Error).message}`);
    }
  }
  store.close();
  return status;
}

const SIGNALS: Readonly<Record<string, number>> = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 };
const signalNumber = (s: string): number | undefined => SIGNALS[s];

if (process.argv[1]?.endsWith("run-unit.js")) {
  runUnit(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e: unknown) => { process.stderr.write(`run-unit: ${(e as Error).message}\n`); process.exitCode = 1; });
}
