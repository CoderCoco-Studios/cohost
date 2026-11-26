import { useEffect, useState } from "react";
import { Banner } from "../components/Banner";
import { Button } from "../components/Button";
import { PageHeading } from "../components/PageHeading";
import { TextField } from "../components/Field";
import type { Api, ApiResult } from "../state/api";
import { useApi } from "../state/hooks";
import { AccessDialog } from "./AccessDialog";

/** One failing key as `GET /recovery` serves it (dashboard DASH-RCV-004). */
export interface RecoveryProblem {
  file: "config" | "secrets";
  path: string;
  message: string;
  kind: "syntax" | "placeholder" | "schema" | "secrets";
  secret: boolean;
  sensitive: boolean;
  section?: { path: string; title: string };
  fallback?: unknown;
  resetPath?: string;
  actions: { set: boolean; reset: boolean; fallback: boolean };
}

/** `GET /recovery` in recovery mode. */
export interface RecoveryState { active: true; file: string; secretsFile: string; etag: string; problems: RecoveryProblem[] }

type WriteResult = { ok: true; etag: string; problems: RecoveryProblem[]; valid: boolean };

/**
 * Asks `GET /recovery` before anything else loads: the recovery state when the dashboard is in config recovery mode, else null
 * (normal mode, or no answer, which leaves the normal shell to report the connection).
 */
// @spec DASH-RCV-013
export async function recoveryState(api: Pick<Api, "get">): Promise<RecoveryState | null> {
  const r = await api.get<RecoveryState | { active: false }>("/recovery");
  return r.ok && r.data.active ? r.data : null;
}

const KIND: Record<RecoveryProblem["kind"], string> = { placeholder: "Placeholder", schema: "Invalid value", syntax: "Syntax error", secrets: "Secrets file" };

const shown = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));

function resetLabel(p: RecoveryProblem): string {
  if (p.file === "secrets") return "Clear in secrets.yaml";
  if (p.secret) return "Remove from config.yaml";
  return p.path.includes("[") ? "Reset the list" : "Reset to default";
}

/** What a refused write says, from its `issues` when it has them. */
function failure(r: Extract<ApiResult<unknown>, { ok: false }>): string {
  if (r.locked) return "Not done: locked.";
  const issues = (r.data as { issues?: { path: string; message: string }[] } | undefined)?.issues;
  if (issues?.length) return issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join("; ");
  return r.detail || `Failed (${r.status}).`;
}

/**
 * The screen config recovery mode shows in place of the shell: every failing key of `config.yaml` and `secrets.yaml` with its
 * actions, Reset all, Check again, and, once the files validate, a wait for the normal dashboard and a reload.
 */
// @spec DASH-RCV-013, DASH-RCV-014, DASH-RCV-015
export function RecoveryScreen({ initial, reload = () => location.reload(), pollMs = 1000 }: { initial: RecoveryState; reload?: () => void; pollMs?: number }) {
  const api = useApi();
  const [state, setState] = useState(initial);
  const [values, setValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [valid, setValid] = useState(false);

  useEffect(() => {
    if (!valid) return;
    let done = false;
    const id = setInterval(() => {
      void api.get<{ active: boolean }>("/recovery").then((r) => {
        if (!done && r.ok && !r.data.active) { done = true; clearInterval(id); reload(); }
      });
    }, pollMs);
    return () => { done = true; clearInterval(id); };
  }, [valid, api, reload, pollMs]);

  const refresh = async (): Promise<void> => {
    const r = await api.get<RecoveryState | { active: false }>("/recovery");
    if (!r.ok) { setErrors({ all: failure(r) }); return; }
    if (!r.data.active) { setValid(true); return; }
    setState(r.data);
    setErrors({});
  };

  const send = async (key: string, op: "set" | "reset" | "reset-all", body: Record<string, unknown>, action: string): Promise<void> => {
    setBusy(key);
    const r = await api.post<WriteResult>(`/recovery/${op}`, { etag: state.etag, ...body }, { auth: "control", action });
    setBusy(null);
    if (r.ok) {
      setState((s) => ({ ...s, etag: r.data.etag, problems: r.data.problems }));
      setErrors({});
      if (r.data.valid) setValid(true);
      return;
    }
    if (r.status === 409 && typeof (r.data as { etag?: unknown } | undefined)?.etag === "string") {
      await refresh();
      setErrors({ [key]: "The file changed since this list was read. The list is fresh now: try again." });
      return;
    }
    setErrors({ [key]: failure(r) });
  };

  const files = [...new Set(state.problems.map((p) => (p.file === "secrets" ? state.secretsFile : state.file)))].join(" and ");
  if (valid) {
    return (
      <main id="main" className="page" tabIndex={-1}>
        <PageHeading>Config recovery</PageHeading>
        <Banner tone="ok" title="The config is valid. Starting the dashboard…">The page reloads as soon as the dashboard is up.</Banner>
      </main>
    );
  }
  return (
    <>
      <main id="main" className="page recovery" tabIndex={-1}>
        <PageHeading>Config recovery</PageHeading>
        <p>The dashboard started in recovery mode because {files} does not validate. Services cannot be started until it does. Fix each key below, or reset them all to their defaults; nothing changes in the file until you press a button.</p>
        <div className="row">
          <Button variant="primary" busy={busy === "all"} disabled={busy !== null} onClick={() => void send("all", "reset-all", {}, "Reset all failing keys")}>Reset all failing keys</Button>
          <Button disabled={busy !== null} onClick={() => void refresh()}>Check again</Button>
        </div>
        {errors.all ? <Banner tone="bad">{errors.all}</Banner> : null}
        <ul className="recovery-list" aria-label="Failing keys">
          {state.problems.map((p, i) => {
            const key = `${p.file}:${p.path}:${i}`;
            const fileName = p.file === "secrets" ? state.secretsFile : state.file;
            const none = !p.actions.set && !p.actions.reset && !p.actions.fallback;
            return (
              <li key={key} className="card">
                <div className="card-h">
                  <h2>{p.path || fileName}</h2>
                  <span className="chip">{KIND[p.kind]}</span>
                  <span className="help">{p.file === "secrets" ? "secrets.yaml" : "config.yaml"}</span>
                </div>
                <div className="card-b stack-y">
                  <p>{p.message}</p>
                  {p.secret && p.file === "config" ? (
                    <p>This is a credential. Remove it from config.yaml here, then set it in Settings, {p.section?.title ?? "its section"}, with its masked field once the dashboard is back.</p>
                  ) : null}
                  {none ? <p>Fix this by hand in {fileName}, then press Check again.</p> : null}
                  {p.actions.set ? (
                    <form className="row" onSubmit={(e) => { e.preventDefault(); void send(key, "set", { path: p.path, value: values[key] ?? "" }, `Set ${p.path}`); }}>
                      <TextField label={`New value for ${p.path}`} value={values[key] ?? ""} onChange={(v) => setValues((m) => ({ ...m, [key]: v }))} autoComplete="off" />
                      <Button type="submit" busy={busy === key} disabled={busy !== null}>Set</Button>
                    </form>
                  ) : null}
                  <div className="row">
                    {p.actions.fallback ? <Button disabled={busy !== null} onClick={() => void send(key, "set", { path: p.path, value: p.fallback }, `Set ${p.path}`)}>Use {shown(p.fallback)}</Button> : null}
                    {p.actions.reset ? <Button disabled={busy !== null} onClick={() => void send(key, "reset", { path: p.path }, `Reset ${p.path}`)}>{resetLabel(p)}</Button> : null}
                  </div>
                  {errors[key] ? <Banner tone="bad">{errors[key]}</Banner> : null}
                </div>
              </li>
            );
          })}
        </ul>
      </main>
      <AccessDialog />
    </>
  );
}
