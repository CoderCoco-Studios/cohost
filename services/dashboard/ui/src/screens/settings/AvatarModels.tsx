// The model list of the `avatar-model` widget (DASH-AVS-002 to DASH-AVS-004): the radio rows after None, Delete, and the upload
// with its limit, progress, refusal and Replace question. Choosing a row is an edit of `renderer.model`; uploading and
// deleting are gated writes that need the control token and change no setting.
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { useApi } from "../../state/hooks";
import type { KeyModel, SectionModel } from "./schemaModel";
import { useSettings, type SectionState } from "./store";

const MIB = 1024 * 1024;
/** A size in mebibytes to one decimal, for the limit and the rows: `2.5 MiB`, `50.0 MiB`. */
export const mib = (bytes: number): string => `${(bytes / MIB).toFixed(1)} MiB`;

/** A stored model as `GET /avatar/models` lists it (DASH-MDL-011). */
export interface StoredModel {
  name: string; bytes: number; active: boolean; vrm: "0" | "1" | null; title: string | null; authors: string[];
  license: { name: string | null; url: string | null } | null; usage: { label: string; value: string }[]; expressions: string[]; error?: string;
}

type ListState =
  | { status: "loading" }
  | { status: "ready"; models: StoredModel[]; maxBytes: number }
  | { status: "unavailable" }
  | { status: "error"; detail: string };

const NOT_HERE = "The models are not available here: the model store is served on the full dashboard listener only.";

/** The list of stored models, read once on open and again after an upload or a delete. */
function useModels(): [ListState, () => Promise<void>] {
  const api = useApi();
  const [list, setList] = useState<ListState>({ status: "loading" });
  const read = async (): Promise<void> => {
    const r = await api.get<{ models?: unknown; maxBytes?: unknown }>("/avatar/models");
    if (r.ok && Array.isArray(r.data?.models) && typeof r.data.maxBytes === "number") {
      setList({ status: "ready", models: r.data.models as StoredModel[], maxBytes: r.data.maxBytes });
    } else if (!r.ok && r.status === 404) {
      setList({ status: "unavailable" });
    } else {
      setList({ status: "error", detail: r.ok ? "the answer had an unexpected shape" : r.detail });
    }
  };
  useEffect(() => { void read(); }, [api]); // eslint-disable-line react-hooks/exhaustive-deps
  return [list, read];
}

interface Replacing { file: File; name: string }

// @spec DASH-AVS-002, DASH-AVS-003, DASH-AVS-004
/**
 * The model list with its upload, for the `renderer.model` key. `value` is the choice in the form (an edit or the saved value);
 * `applied` is the model the renderer applies, which cannot be deleted.
 */
export function AvatarModels({ section, km, st }: { section: SectionModel; km: KeyModel; st: SectionState }) {
  const api = useApi();
  const settings = useSettings();
  const [list, refresh] = useModels();
  const groupName = useId();
  const reasonId = useId();
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [uploadError, setUploadError] = useState<string | undefined>();
  const [deleteError, setDeleteError] = useState<string | undefined>();
  const [replacing, setReplacing] = useState<Replacing | undefined>();

  const edit = st.edits[km.key];
  const choice = edit ? String(edit.value ?? "") : String(st.keys[km.key]?.value ?? "");
  const saved = String(st.keys[km.key]?.value ?? "");
  const pick = (name: string) => settings.edit(section.path, km.key, name);

  /** One upload runs at a time; a second file picked meanwhile is not sent. */
  async function send(file: File, replace: boolean): Promise<void> {
    inFlight.current = true;
    setBusy(true);
    setUploadError(undefined);
    const query = `name=${encodeURIComponent(file.name)}${replace ? "&replace=1" : ""}`;
    const r = await api.post<unknown>(`/avatar/models?${query}`, file, { auth: "control", action: `Upload ${file.name}`, contentType: "application/octet-stream" });
    inFlight.current = false;
    setBusy(false);
    if (r.ok) { void refresh(); return; }
    if (r.locked) { setUploadError("The upload was cancelled: no control token was given."); return; }
    const data = r.data as { name?: unknown } | undefined;
    if (r.status === 409 && typeof data?.name === "string") { setReplacing({ file, name: data.name }); return; }
    setUploadError(r.detail);
  }

  function choose(file: File | undefined): void {
    if (!file || inFlight.current || list.status !== "ready") return;
    if (!/\.vrm$/i.test(file.name)) { setUploadError("Only .vrm files can be uploaded: choose a file whose name ends in .vrm."); return; }
    if (file.size > list.maxBytes) { setUploadError(`${file.name} is ${mib(file.size)}, larger than the ${mib(list.maxBytes)} limit.`); return; }
    void send(file, false);
  }

  async function remove(m: StoredModel): Promise<void> {
    setDeleteError(undefined);
    const r = await api.request("DELETE", `/avatar/models/${encodeURIComponent(m.name)}`, undefined, { auth: "control", action: `Delete ${m.name}` });
    if (!r.ok) { if (!r.locked) setDeleteError(`${m.name}: ${r.detail}`); return; }
    // The row held the unsaved choice: the choice goes with it, so no radio stays on a model that is gone.
    if (edit && String(edit.value) === m.name) settings.revert(section.path, km.key);
    void refresh();
  }

  return (
    <div className="stack-y">
      {list.status === "unavailable" ? <p className="help">{NOT_HERE}</p> : null}
      {list.status === "error" ? <p className="field-error">{`Could not read the model list: ${list.detail}`}</p> : null}
      {list.status === "loading" ? <p className="help muted">Reading the stored models…</p> : null}
      {list.status === "ready" ? (
        <div role="radiogroup" aria-label={km.label} className="model-list">
          <ul className="plain">
            <li className="model-row">
              <div className="model-head">
                <label className="model-pick">
                  <input type="radio" name={groupName} value="" checked={choice === ""} onChange={() => pick("")} />
                  <span>None</span>
                </label>
                {choice === "" && saved !== "" ? <span className="tag">unsaved</span> : null}
              </div>
            </li>
            {list.models.map((m) => {
              const unsaved = edit !== undefined && choice === m.name && saved !== m.name;
              return (
                <li key={m.name} className={`model-row${m.error ? " is-broken" : ""}`}>
                  <div className="model-head">
                    <label className="model-pick">
                      <input type="radio" name={groupName} value={m.name} checked={choice === m.name} disabled={!!m.error} onChange={() => pick(m.name)} />
                      <span className="mono">{m.name}</span>
                    </label>
                    <span className="small muted">{mib(m.bytes)}</span>
                    {m.active ? <span className="tag">applied</span> : null}
                    {unsaved ? <span className="tag">unsaved</span> : null}
                    <Button size="sm" aria-label={`Delete ${m.name}`} disabled={m.active} aria-describedby={m.active ? reasonId : undefined} onClick={() => void remove(m)}>Delete</Button>
                  </div>
                  {m.active ? <p className="help small" id={reasonId}>The applied model cannot be deleted: select another model, or none, and save first.</p> : null}
                  {m.error ? <p className="field-error small">{m.error}</p> : (
                    <div className="model-meta small muted">
                      <span>{m.vrm === "0" ? "VRM 0.x" : "VRM 1.0"}</span>
                      {m.title ? <span>{m.title}</span> : null}
                      {m.authors.length > 0 ? <span>{`by ${m.authors.join(", ")}`}</span> : null}
                      <span>{m.license ? `Licence: ${m.license.name ?? "not named"}${m.license.url ? ` (${m.license.url})` : ""}` : "Licence: none given"}</span>
                      {m.usage.length > 0 ? <span>{m.usage.map((u) => `${u.label}: ${u.value}`).join("; ")}</span> : null}
                      {m.expressions.length > 0 ? <span>{`Expressions: ${m.expressions.join(", ")}`}</span> : null}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          {list.models.length === 0 ? <p className="help">No models are stored yet. Upload a .vrm file below.</p> : null}
        </div>
      ) : null}
      <p className="help">The terms are the model author&apos;s. cohost enforces none of them, so read them before using the model on stream.</p>
      {deleteError ? <p role="alert" className="field-error">{deleteError}</p> : null}
      {list.status === "ready" ? (
        <div className="upload-box stack-y"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); choose(e.dataTransfer.files[0]); }}>
          <p className="help">{`Upload a .vrm model, up to ${mib(list.maxBytes)}. A file already stored under the same name asks before it is replaced.`}</p>
          <input type="file" accept=".vrm" aria-label="Upload a .vrm model" disabled={busy}
            onChange={(e) => { choose(e.target.files?.[0]); e.target.value = ""; }} />
          {busy ? <progress aria-label="Uploading" className="upload-progress" /> : null}
          {uploadError ? <p role="alert" className="field-error">{uploadError}</p> : null}
        </div>
      ) : null}
      <Dialog open={replacing !== undefined} title={replacing ? `Replace ${replacing.name}?` : ""} onClose={() => setReplacing(undefined)}
        footer={<>
          <Button onClick={() => setReplacing(undefined)}>Cancel</Button>
          <Button variant="primary" onClick={() => { const r = replacing!; setReplacing(undefined); void send(r.file, true); }}>Replace</Button>
        </>}>
        <p>A model of that name is stored. Replacing it overwrites the stored file.</p>
      </Dialog>
    </div>
  );
}
