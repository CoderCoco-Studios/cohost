// Secret keys (design: Secrets). A secret is never read back: the field holds only what the operator typed, the writes go to
// the secret routes with the control token, and the section's edit count and save bar are not involved (DASH-SET-009).
import { useId, useState } from "react";
import { Button } from "../../components/Button";
import { ConfirmDialog } from "../../components/Dialog";
import { SecretField } from "../../components/SecretField";
import { RowShell } from "./RowShell";
import type { KeyModel, KeyRead, SectionModel } from "./schemaModel";
import { useSettings } from "./store";

/**
 * Secrets that only work together: the services refuse to start with exactly one of them set, and the secret routes refuse a
 * write that would leave one (DASH-SECRET-012). The screen saves them with one request. Full config paths, not section names.
 */
export const SECRET_PAIRS: { title: string; paths: [string, string] }[] = [
  { title: "Bedrock", paths: ["llm.bedrock.access_key_id", "llm.bedrock.secret_access_key"] },
];

/** The pair a section's key belongs to, with the two keys' names relative to the section. */
export function pairOf(section: SectionModel, key: string): { title: string; keys: [string, string] } | undefined {
  const full = `${section.path}.${key}`;
  const pair = SECRET_PAIRS.find((p) => p.paths.includes(full));
  if (!pair) return undefined;
  const keys = pair.paths.map((p) => p.slice(section.path.length + 1)) as [string, string];
  return section.keys.some((k) => k.key === keys[0]) && section.keys.some((k) => k.key === keys[1]) ? { title: pair.title, keys } : undefined;
}

/** One secret: Set or Not set, a masked field, Save and Clear. */
// @spec DASH-SET-009
export function SecretRow({ section, km, info }: { section: SectionModel; km: KeyModel; info: KeyRead | undefined }) {
  const settings = useSettings();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const path = `${section.path}.${km.key}`;
  const write = async (value: string | null): Promise<boolean> => {
    setBusy(true); setError(undefined);
    const r = await settings.setSecrets(section.path, { [km.key]: value }, `${value === null ? "Clear" : "Set"} ${path}`);
    setBusy(false);
    if (!r.ok) { setError(r.detail); return false; }
    return true;
  };
  return (
    <RowShell section={section.path} name={km.key} path={path} label={km.label} hideLabel source="secret">
      <div className="embedded">
        <SecretField label={km.label} isSet={!!info?.set} busy={busy} help={km.help} error={error} onSave={(v) => write(v)} onClear={() => write(null)} />
      </div>
      {km.sensitive ? <p className="help">Changing this needs the control token.</p> : null}
    </RowShell>
  );
}

/** Two secrets saved and cleared together, so a half-set pair cannot be made (DASH-SECRET-011, DASH-SECRET-012). */
// @spec DASH-SET-009
export function SecretPair({ section, title, keys, models, reads }: { section: SectionModel; title: string; keys: [string, string]; models: [KeyModel, KeyModel]; reads: [KeyRead | undefined, KeyRead | undefined] }) {
  const settings = useSettings();
  const ids = [useId(), useId()];
  const [typed, setTyped] = useState<[string, string]>(["", ""]);
  const [shown, setShown] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const isSet = [!!reads[0]?.set, !!reads[1]?.set];
  const has = [typed[0].trim() !== "", typed[1].trim() !== ""];
  // Both typed, or one typed while the other is already stored (a rotation): never a state with exactly one value.
  const canSave = (has[0] && has[1]) || (has[0] && isSet[1]) || (has[1] && isSet[0]);
  const names = [`${title} ${models[0].label.toLowerCase()}`, `${title} ${models[1].label.toLowerCase()}`];
  const send = async (values: Record<string, string | null>, action: string): Promise<boolean> => {
    setBusy(true); setError(undefined);
    const r = await settings.setSecrets(section.path, values, action);
    setBusy(false);
    if (!r.ok) { setError(r.detail); return false; }
    return true;
  };
  const save = async () => {
    const values: Record<string, string> = {};
    if (has[0]) values[keys[0]] = typed[0];
    if (has[1]) values[keys[1]] = typed[1];
    if (await send(values, `Set ${title} keys`)) setTyped(["", ""]);
  };
  const row = (i: 0 | 1) => {
    const errId = error ? `${ids[i]}-error` : undefined;
    return (
      <RowShell key={keys[i]} section={section.path} name={keys[i]} path={`${section.path}.${keys[i]}`} label={models[i].label} hideLabel source="secret">
        <div className="secret-field">
          <label className="label sr-only" htmlFor={ids[i]}>{names[i]}</label>
          <div className="secret">
            <input id={ids[i]} className="field" type={shown ? "text" : "password"} autoComplete="off" spellCheck={false} value={typed[i]}
              placeholder={isSet[i] ? "Type a new value to replace it" : "Type the value"} aria-describedby={[`${ids[i]}-help`, errId].filter(Boolean).join(" ")} aria-invalid={error ? true : undefined}
              onChange={(e) => setTyped(i === 0 ? [e.target.value, typed[1]] : [typed[0], e.target.value])} />
          </div>
          <p className="help"><span className={`tag ${isSet[i] ? "tag-set" : ""}`}>{isSet[i] ? "Set" : "Not set"}</span></p>
          {models[i].help ? <p className="help" id={`${ids[i]}-help`}>{models[i].help}</p> : <span id={`${ids[i]}-help`} />}
          {error ? <p className="help field-error" id={errId}>{error}</p> : null}
        </div>
      </RowShell>
    );
  };
  return (
    <>
      {row(0)}
      {row(1)}
      <div className="srow">
        <div className="srow-k"><span className="label">{`${title} keys`}</span></div>
        <div className="srow-c row">
          <Button aria-pressed={shown} onClick={() => setShown((s) => !s)}>{shown ? "Hide" : "Show"}</Button>
          <Button variant="primary" onClick={save} disabled={!canSave} busy={busy}>{`Save both ${title} keys`}</Button>
          {isSet[0] || isSet[1] ? <Button variant="danger" onClick={() => setConfirming(true)} disabled={busy}>{`Clear both ${title} keys`}</Button> : null}
          <p className="help">They are saved together: the services refuse to start with only one of the two set.</p>
        </div>
        <div className="srow-s" />
      </div>
      <ConfirmDialog open={confirming} title={`Clear both ${title} keys?`} confirmLabel="Clear" danger onCancel={() => setConfirming(false)}
        onConfirm={() => { setConfirming(false); void send({ [keys[0]]: null, [keys[1]]: null }, `Clear ${title} keys`); }}>
        Both stored values are removed and read as not set. The service that uses them must restart to notice.
      </ConfirmDialog>
    </>
  );
}
