import { useEffect, useState } from "react";
import { Banner } from "../components/Banner";
import { Button } from "../components/Button";
import { PageHeading } from "../components/PageHeading";
import { TextField } from "../components/Field";
import { FilePicker } from "../components/FilePicker";
import type { Api, ApiResult } from "../state/api";
import { useApi } from "../state/hooks";
import { AccessDialog } from "./AccessDialog";

/** Why the settings store cannot be used (dashboard DASH-RCV-004). */
export type RecoveryCause = "damaged-store" | "newer-store" | "missing-key" | "invalid-settings";

/** One problem as `GET /recovery` serves it (DASH-RCV-004). */
export interface RecoveryProblem {
  path: string;
  message: string;
  sensitive: boolean;
  section?: { path: string; title: string };
  actions: { set: boolean; reset: boolean };
}

/** A backup the store keeps (settings-store STORE-DB-008), newest first. */
export interface RecoveryBackup { name: string; time: string }

/** `GET /recovery` in recovery mode. */
export interface RecoveryState {
  active: true;
  cause: RecoveryCause;
  /** The store's revision; absent while the store cannot be read. */
  etag?: string;
  problems: RecoveryProblem[];
  backups: RecoveryBackup[];
  /** False when the token verifier cannot be read: the fix is a host command (DASH-RCV-028). */
  gated: boolean;
}

type WriteResult = { ok: true; etag?: string; problems: RecoveryProblem[]; valid: boolean; moved?: true; port?: number };

/** The port the normal dashboard moves to, when the server says it moves; otherwise it comes up where the page is. */
const movedTo = (r: { moved?: true; port?: number }): { port?: number } => (r.moved && r.port !== undefined ? { port: r.port } : {});

/** Where the page is: the parts the wait for the normal dashboard compares and builds addresses from. */
export interface PageLocation { protocol: string; hostname: string; port: string }

const defaultReload = (): void => location.reload();
const defaultNavigate = (url: string): void => location.assign(url);
/** Resolves when anything answers at `url` (an opaque answer is enough), rejects on a network error. */
const defaultProbe = async (url: string): Promise<void> => { await fetch(url, { mode: "no-cors", cache: "no-store" }); };

/** Polls that fail before the screen names the address it is waiting for. */
export const WAIT_NOTICE_AFTER = 10;
/** What the owner types before the stored credentials are discarded (DASH-RCV-027). */
export const DISCARD_CONFIRMATION = "delete credentials";

/**
 * Asks `GET /recovery` before anything else loads: the recovery state when the dashboard is in config recovery mode, else null
 * (normal mode, or no answer, which leaves the normal shell to report the connection).
 */
// @spec DASH-RCV-013
export async function recoveryState(api: Pick<Api, "get">): Promise<RecoveryState | null> {
  const r = await api.get<RecoveryState | { active: false }>("/recovery");
  return r.ok && r.data.active ? r.data : null;
}

/** The sentence that names the cause (DASH-RCV-013). */
const CAUSE: Record<RecoveryCause, string> = {
  "damaged-store": "the settings store is damaged",
  "newer-store": "the settings store was made by a newer build of cohost",
  "missing-key": "the settings store's master key is missing or wrong",
  "invalid-settings": "the stored settings do not pass this build's checks",
};

/** The host commands that fix a store whose token verifier cannot be read (DASH-RCV-028). */
const HOST_COMMANDS = ["mise run config:restore -- <backup>", "mise run config:import -- <export file>", "mise run config:key -- --restore"];

/** What a refused write says, from its `issues` when it has them. */
function failure(r: Extract<ApiResult<unknown>, { ok: false }>): string {
  if (r.locked) return "Not done: locked.";
  const issues = (r.data as { issues?: { path: string; message: string }[] } | undefined)?.issues;
  if (issues?.length) return issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join("; ");
  return r.detail || `Failed (${r.status}).`;
}

/**
 * The screen config recovery mode shows in place of the shell: the cause, Check again, Stop the stack, and by cause the
 * failing keys with Set and Reset (invalid settings), the backups and an import (damaged store), the recovery key and the
 * discard of the credentials (missing key), or the host commands when the token cannot be checked; once the store can be used,
 * a wait for the normal dashboard and a reload.
 */
// @spec DASH-RCV-013, DASH-RCV-015, DASH-RCV-021, DASH-RCV-028
export function RecoveryScreen({ initial, reload = defaultReload, navigate = defaultNavigate, probe = defaultProbe, here = location, pollMs = 1000 }: {
  initial: RecoveryState;
  reload?: () => void;
  navigate?: (url: string) => void;
  probe?: (url: string) => Promise<void>;
  here?: PageLocation;
  pollMs?: number;
}) {
  const api = useApi();
  const [state, setState] = useState(initial);
  const [values, setValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  // Set once the store can be used: the port the normal dashboard moves to, when the server says it moves (else it comes up here).
  const [valid, setValid] = useState<{ port?: number } | null>(null);
  const [misses, setMisses] = useState(0);
  const [stopped, setStopped] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [recoveryKey, setRecoveryKey] = useState("");
  const [confirm, setConfirm] = useState("");

  const target = valid?.port !== undefined ? `${here.protocol}//${here.hostname}:${valid.port}/` : undefined;
  const ownAddress = `${here.protocol}//${here.hostname}${here.port ? `:${here.port}` : ""}/`;

  // The wait for the normal dashboard: on this origin, until GET /recovery answers inactive, then a reload; on a new port,
  // until anything answers there, then a move to it.
  useEffect(() => {
    if (!valid) return;
    let done = false;
    const id = setInterval(() => {
      const tick = target
        ? probe(`${target}health`).then(() => true, () => false)
        : api.get<{ active: boolean }>("/recovery").then((r) => r.ok && !r.data.active);
      void tick.then((up) => {
        if (done) return;
        if (!up) { setMisses((m) => m + 1); return; }
        done = true;
        clearInterval(id);
        if (target) navigate(target); else reload();
      });
    }, pollMs);
    return () => { done = true; clearInterval(id); };
  }, [valid, target, api, reload, navigate, probe, pollMs]);

  const refresh = async (): Promise<void> => {
    const r = await api.get<RecoveryState | { active: false; moved?: true; port?: number }>("/recovery");
    if (!r.ok) { setErrors({ all: failure(r) }); return; }
    if (!r.data.active) { setValid(movedTo(r.data)); return; }
    setState(r.data);
    setErrors({});
  };

  const send = async (key: string, op: string, body: Record<string, unknown>, action: string): Promise<void> => {
    setBusy(key);
    const r = await api.post<WriteResult>(`/recovery/${op}`, body, { auth: "control", action });
    setBusy(null);
    if (r.ok) {
      setState((s) => ({ ...s, ...(r.data.etag !== undefined ? { etag: r.data.etag } : {}), problems: r.data.problems }));
      setErrors({});
      if (r.data.valid) setValid(movedTo(r.data));
      else await refresh();
      return;
    }
    if (r.status === 409 && typeof (r.data as { etag?: unknown } | undefined)?.etag === "string") {
      await refresh();
      setErrors({ [key]: "The settings changed since this list was read. The list is fresh now: try again." });
      return;
    }
    setErrors({ [key]: failure(r) });
  };

  const stopStack = async (): Promise<void> => {
    setBusy("stop");
    const r = await api.post<{ ok: true; action: "stop" }>("/stack/stop", undefined, { auth: "control", action: "Stop the stack" });
    setBusy(null);
    setStopped(r.ok);
    setErrors(r.ok ? {} : { stop: failure(r) });
  };

  const importExport = async (): Promise<void> => {
    if (!importFile) { setErrors({ import: "Choose an export file first." }); return; }
    const text = await importFile.text();
    await send("import", "import", { text, ...(passphrase ? { passphrase } : {}) }, "Import the settings");
  };

  if (valid) {
    return (
      <main id="main" className="page" tabIndex={-1}>
        <PageHeading>Config recovery</PageHeading>
        <Banner tone="ok" title="The settings are valid. Starting the dashboard…">
          {target ? (
            <span>The saved settings move the dashboard to a new address: <a href={target}>{target}</a>. This page goes there as soon as it answers; the link works too once it is up.</span>
          ) : "The page reloads as soon as the dashboard is up."}
        </Banner>
        {misses >= WAIT_NOTICE_AFTER ? <Banner tone="warn">Still waiting for the dashboard at {target ?? ownAddress}. Check the terminal it runs in; you can open that address yourself once it is up.</Banner> : null}
      </main>
    );
  }
  const busyAny = busy !== null;
  return (
    <>
      <main id="main" className="page recovery" tabIndex={-1}>
        <PageHeading>Config recovery</PageHeading>
        <p>The dashboard started in recovery mode because {CAUSE[state.cause]}. Services cannot be started until it is fixed; nothing changes in the store until you press a button.</p>
        <div className="row">
          {state.cause === "invalid-settings" && state.gated ? (
            <Button variant="primary" busy={busy === "all"} disabled={busyAny} onClick={() => void send("all", "reset-all", { etag: state.etag }, "Reset all failing keys")}>Reset all failing keys</Button>
          ) : null}
          <Button disabled={busyAny} onClick={() => void refresh()}>Check again</Button>
          <Button busy={busy === "stop"} disabled={busyAny} onClick={() => void stopStack()}>Stop the stack</Button>
        </div>
        {errors.all ? <Banner tone="bad">{errors.all}</Banner> : null}
        {errors.stop ? <Banner tone="bad">{errors.stop}</Banner> : null}
        {stopped ? <Banner tone="ok">The stack is stopped.</Banner> : null}

        {!state.gated ? (
          <Banner tone="warn" title="Fix this on the host">
            <p>The store cannot be read, so the dashboard cannot check the control token and offers no action here. In the cohost folder, run one of:</p>
            <ul>{HOST_COMMANDS.map((c) => <li key={c}><code>{c}</code></li>)}</ul>
          </Banner>
        ) : null}

        {state.cause !== "invalid-settings" ? state.problems.map((p, i) => <Banner key={i} tone="bad">{p.message}</Banner>) : null}

        {state.gated && state.cause === "invalid-settings" ? (
          <ul className="recovery-list" aria-label="Failing keys">
            {state.problems.map((p, i) => {
              const key = `${p.path}:${i}`;
              return (
                <li key={key} className="card">
                  <div className="card-h">
                    <h2>{p.path}</h2>
                    {p.section ? <span className="help">{p.section.title}</span> : null}
                  </div>
                  <div className="card-b stack-y">
                    <p>{p.message}</p>
                    {!p.actions.set && !p.actions.reset ? <p>This key cannot be changed here on its own: use Reset all failing keys, or import an export.</p> : null}
                    {p.actions.set ? (
                      <form className="row" onSubmit={(e) => { e.preventDefault(); void send(key, "set", { etag: state.etag, path: p.path, value: values[key] ?? "" }, `Set ${p.path}`); }}>
                        <TextField label={`New value for ${p.path}`} value={values[key] ?? ""} onChange={(v) => setValues((m) => ({ ...m, [key]: v }))} autoComplete="off" />
                        <Button type="submit" busy={busy === key} disabled={busyAny}>Set</Button>
                      </form>
                    ) : null}
                    {p.actions.reset ? (
                      <div className="row">
                        <Button disabled={busyAny} onClick={() => void send(key, "reset", { etag: state.etag, path: p.path }, `Reset ${p.path}`)}>{p.path.includes("[") ? "Reset the list" : "Reset to default"}</Button>
                      </div>
                    ) : null}
                    {errors[key] ? <Banner tone="bad">{errors[key]}</Banner> : null}
                  </div>
                </li>
              );
            })}
          </ul>
        ) : null}

        {state.gated && state.cause === "damaged-store" ? (
          <section className="card stack-y" aria-label="Restore or import">
            <h2>Restore a backup</h2>
            {state.backups.length === 0 ? <p>The store has no backups.</p> : (
              <ul className="recovery-list" aria-label="Backups">
                {state.backups.map((b) => (
                  <li key={b.name} className="row">
                    <span>{b.time}</span>
                    <Button busy={busy === `restore:${b.name}`} disabled={busyAny} onClick={() => void send(`restore:${b.name}`, "restore", { backup: b.name }, `Restore ${b.name}`)}>Restore</Button>
                  </li>
                ))}
              </ul>
            )}
            {Object.entries(errors).filter(([k]) => k.startsWith("restore:")).map(([k, v]) => <Banner key={k} tone="bad">{v}</Banner>)}
            <h2>Import an export</h2>
            <form className="stack-y" onSubmit={(e) => { e.preventDefault(); void importExport(); }}>
              <label htmlFor="recovery-import">Export file</label>
              <FilePicker id="recovery-import" accept=".yaml,.yml" onChange={setImportFile} />
              <TextField label="Passphrase (when the export holds credentials)" type="password" autoComplete="off" value={passphrase} onChange={setPassphrase} />
              <div className="row"><Button type="submit" busy={busy === "import"} disabled={busyAny}>Import</Button></div>
            </form>
            {errors.import ? <Banner tone="bad">{errors.import}</Banner> : null}
          </section>
        ) : null}

        {state.gated && state.cause === "missing-key" ? (
          <section className="card stack-y" aria-label="Master key">
            <h2>Restore the master key</h2>
            <form className="row" onSubmit={(e) => { e.preventDefault(); void send("key", "key", { recoveryKey }, "Save the recovery key"); }}>
              <TextField label="Recovery key" type="password" autoComplete="off" value={recoveryKey} onChange={setRecoveryKey} />
              <Button type="submit" busy={busy === "key"} disabled={busyAny}>Save key</Button>
            </form>
            {errors.key ? <Banner tone="bad">{errors.key}</Banner> : null}
            <h2>Discard the stored credentials</h2>
            <p>Without the recovery key the stored credentials cannot be read. Discarding them makes a new key; every credential must then be entered again. Type <code>{DISCARD_CONFIRMATION}</code> to confirm.</p>
            <form className="row" onSubmit={(e) => { e.preventDefault(); void send("discard", "discard-credentials", { confirm }, "Discard the stored credentials"); }}>
              <TextField label="Confirmation" autoComplete="off" value={confirm} onChange={setConfirm} />
              <Button type="submit" busy={busy === "discard"} disabled={busyAny || confirm !== DISCARD_CONFIRMATION}>Discard the stored credentials</Button>
            </form>
            {errors.discard ? <Banner tone="bad">{errors.discard}</Banner> : null}
          </section>
        ) : null}
      </main>
      <AccessDialog />
    </>
  );
}
