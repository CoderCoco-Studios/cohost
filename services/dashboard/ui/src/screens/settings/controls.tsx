// The field renderers of the Settings screen: one native control per `Control` kind (design: Widgets). Each takes the
// value in wire form and reports a new one; text typed into a box that does not map one-to-one (a list of lines, a number,
// JSON) is kept in local draft state so a half-typed value is never rewritten under the cursor.
import { useEffect, useId, useState, type ReactNode } from "react";
import { Button } from "../../components/Button";
import { Chips } from "../../components/Chips";
import { ModelPicker } from "../../components/ModelPicker";
import { SegmentedGroup } from "../../components/SegmentedGroup";
import { Slider } from "../../components/Slider";
import { Switch } from "../../components/Switch";
import { TilePicker } from "../../components/TilePicker";
import { VoicePicker } from "../../components/VoicePicker";
import { CURATED_MODELS, KNOWN_SOURCES, timeZones } from "./curated";
import type { PickList } from "./picklists";
import type { Control, ItemProp, JsonSchema, Option } from "./schemaModel";
import { fromLines, type Errors } from "./validate";

/** What every control gets from its row: the element ids that tie it to its label, help and error. */
export interface Wiring { id: string; describedBy?: string; invalid: boolean }

export interface ControlProps {
  control: Control;
  /** The key's label, the accessible name of a control that has no `<label>` of its own. */
  label: string;
  value: unknown;
  /** The error text of a control that can only report it by itself. */
  onChange: (value: unknown, error?: string) => void;
  wiring: Wiring;
  unit?: string;
  schema: JsonSchema;
  /** The value the file or the schema default holds, which decides whether a text box is a text area. */
  settled?: unknown;
  help?: string;
  placeholder?: string;
  models?: PickList;
  voices?: PickList;
  /** Errors by sub-path, for a list of cards. */
  errors?: Errors;
  /** Whether the row's own label is a real `<label for>` for this control. */
  disabled?: boolean;
}

/** Whether a control is one a `<label for>` can name (a native single control). */
export const isLabelable = (c: Control): boolean => ["select", "number", "text", "textarea", "lines", "timezone", "json"].includes(c.kind);
/** Whether a control brings its own label and help (the shared pickers and the secret field). */
export const isEmbedded = (c: Control): boolean => ["model", "voice", "secret"].includes(c.kind);

const asString = (v: unknown): string => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));
const asList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const lc = (s: string) => s.toLowerCase();

function withExtra(options: Option[], current: string[]): Option[] {
  const known = new Set(options.map((o) => o.value));
  return [...options, ...current.filter((v) => !known.has(v)).map((v) => ({ value: v, label: v }))];
}

/** A number box: the text typed stays as typed while it is being edited; an empty box is not a number. */
function NumberBox({ value, onChange, wiring, step, unit, schema }: { value: unknown; onChange: (v: number) => void; wiring: Wiring; step?: number; unit?: string; schema: JsonSchema }) {
  const n = typeof value === "number" ? value : Number.NaN;
  const [draft, setDraft] = useState(Number.isFinite(n) ? String(n) : "");
  useEffect(() => {
    // An outside change (Discard, a reload) replaces the draft; typing that parses to the same number keeps it.
    setDraft((d) => (Number(d) === n || (d.trim() === "" && Number.isNaN(n)) ? d : Number.isFinite(n) ? String(n) : ""));
  }, [n]);
  return (
    <span className="row">
      <input id={wiring.id} className="field num" type="number" inputMode={schema.type === "integer" ? "numeric" : "decimal"} step={step ?? (schema.type === "integer" ? 1 : "any")}
        min={schema.minimum} max={schema.maximum} value={draft} aria-describedby={wiring.describedBy} aria-invalid={wiring.invalid || undefined}
        onChange={(e) => { setDraft(e.target.value); onChange(e.target.value.trim() === "" ? Number.NaN : Number(e.target.value)); }} />
      {unit ? <span className="small muted">{unit}</span> : null}
    </span>
  );
}

/** One value per line (DASH-SET-019). */
function LinesBox({ value, onChange, wiring, rows = 4 }: { value: unknown; onChange: (v: string[]) => void; wiring: Wiring; rows?: number }) {
  const list = asList(value);
  const [text, setText] = useState(list.join("\n"));
  useEffect(() => { setText((t) => (JSON.stringify(fromLines(t)) === JSON.stringify(list) ? t : list.join("\n"))); }, [list.join("\n")]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <textarea id={wiring.id} className="field" rows={rows} spellCheck={false} value={text} aria-describedby={wiring.describedBy} aria-invalid={wiring.invalid || undefined}
      onChange={(e) => { setText(e.target.value); onChange(fromLines(e.target.value)); }} />
  );
}

/** The fallback for a shape with no control: the value as JSON, checked before it is saved (DASH-SET-026). */
function JsonBox({ value, onChange, wiring }: { value: unknown; onChange: (v: unknown, error?: string) => void; wiring: Wiring }) {
  const pretty = JSON.stringify(value ?? null, null, 2);
  const [text, setText] = useState(pretty);
  const [bad, setBad] = useState<string | undefined>();
  useEffect(() => { if (!bad) setText((t) => { try { return JSON.stringify(JSON.parse(t)) === JSON.stringify(value ?? null) ? t : pretty; } catch { return pretty; } }); }, [pretty]); // eslint-disable-line react-hooks/exhaustive-deps
  const errId = useId();
  return (
    <>
      <textarea id={wiring.id} className="field mono" rows={6} spellCheck={false} value={text} aria-describedby={[wiring.describedBy, bad ? errId : null].filter(Boolean).join(" ") || undefined} aria-invalid={wiring.invalid || !!bad || undefined}
        onChange={(e) => {
          setText(e.target.value);
          try { const parsed = JSON.parse(e.target.value) as unknown; setBad(undefined); onChange(parsed); }
          catch (err) { const m = `Not valid JSON: ${(err as Error).message}`; setBad(m); onChange(value, m); }
        }} />
      <p className="help"><span className="tag">raw JSON</span> This setting has no dedicated control; edit it as JSON.</p>
      {bad ? <p className="help field-error" id={errId}>{bad}</p> : null}
    </>
  );
}

function ModelBox(p: ControlProps & { control: Extract<Control, { kind: "model" }> }) {
  const installed = p.models ?? [];
  const optional = p.schema.minLength === undefined || p.schema.minLength < 1;
  return (
    <ModelPicker label={p.label} value={asString(p.value)} onChange={(v) => p.onChange(v)} installed={installed} curated={p.models === null ? [] : CURATED_MODELS[p.control.modelKind]} help={p.help}
      placeholder={optional && p.control.modelKind !== "chat" ? "Same as the main model" : undefined} unreachable={p.models === null ? "the model server" : undefined} />
  );
}

/** A select over the browser's time zones, or a text box where the browser has no list (DASH-SET-021). */
function TimezoneBox({ value, onChange, wiring }: { value: unknown; onChange: (v: string) => void; wiring: Wiring }) {
  const current = asString(value);
  const zones = timeZones(current);
  if (!zones) return <input id={wiring.id} className="field" type="text" value={current} aria-describedby={wiring.describedBy} aria-invalid={wiring.invalid || undefined} onChange={(e) => onChange(e.target.value)} />;
  return (
    <select id={wiring.id} className="field" value={current} aria-describedby={wiring.describedBy} aria-invalid={wiring.invalid || undefined} onChange={(e) => onChange(e.target.value)}>
      {zones.map((z) => <option key={z} value={z}>{z}</option>)}
    </select>
  );
}

function defaultItem(props: ItemProp[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of props) {
    if (p.schema.default !== undefined) out[p.name] = structuredClone(p.schema.default);
    else if (p.required) out[p.name] = p.schema.type === "array" ? [] : p.schema.type === "string" ? "" : p.schema.type === "boolean" ? false : undefined;
  }
  return out;
}

const singular = (label: string): string => {
  const w = label.trim();
  if (/(x|s|ch|sh)es$/i.test(w)) return w.slice(0, -2);
  return /s$/i.test(w) && !/ss$/i.test(w) ? w.slice(0, -1) : w;
};

/** A list of objects as one card per item: Add and Remove, a numbered heading and each property's help (DASH-SET-020). */
function ObjectsEditor({ props, value, onChange, label, wiring, errors = {} }: { props: ItemProp[]; value: unknown; onChange: (v: unknown) => void; label: string; wiring: Wiring; errors?: Errors }) {
  const items = (Array.isArray(value) ? value : []) as Record<string, unknown>[];
  const noun = singular(label);
  const setAt = (i: number, patch: Record<string, unknown>) => onChange(items.map((it, j) => (j === i ? { ...it, ...patch } : it)));
  return (
    <div className="cards" id={wiring.id} aria-describedby={wiring.describedBy}>
      {items.length === 0 ? <p className="muted small">{`No ${lc(label)} yet. Use Add to create the first.`}</p> : null}
      {items.map((it, i) => (
        <ItemCard key={i} n={i + 1} noun={noun} props={props} item={it} errors={errors} index={i} onPatch={(patch) => setAt(i, patch)} onRemove={() => onChange(items.filter((_, j) => j !== i))} />
      ))}
      <div><Button onClick={() => onChange([...items, defaultItem(props)])}>{`Add a ${lc(noun)}`}</Button></div>
    </div>
  );
}

function ItemCard({ n, noun, props, item, errors, index, onPatch, onRemove }: { n: number; noun: string; props: ItemProp[]; item: Record<string, unknown>; errors: Errors; index: number; onPatch: (p: Record<string, unknown>) => void; onRemove: () => void }) {
  const headingId = useId();
  const title = `${noun} ${n}`;
  return (
    <section className="card item-card" role="group" aria-labelledby={headingId}>
      <div className="card-h">
        <h3 id={headingId} className="grow">{title}</h3>
        <Button variant="danger" size="sm" aria-label={`Remove ${lc(title)}`} onClick={onRemove}>Remove</Button>
      </div>
      <div className="card-b stack-y">
        {props.map((p) => (
          <ItemProperty key={p.name} prop={p} value={item[p.name]} error={errors[`${index}.${p.name}`]} sub={prefixed(errors, `${index}.${p.name}.`)} onChange={(v) => onPatch({ [p.name]: v })} />
        ))}
      </div>
    </section>
  );
}

function prefixed(errors: Errors, prefix: string): Errors {
  return Object.fromEntries(Object.entries(errors).filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k.slice(prefix.length), v]));
}

function ItemProperty({ prop, value, error, sub, onChange }: { prop: ItemProp; value: unknown; error?: string; sub: Errors; onChange: (v: unknown) => void }) {
  const id = useId();
  const helpId = prop.help ? `${id}-help` : undefined, errId = error ? `${id}-error` : undefined;
  const wiring: Wiring = { id, describedBy: [helpId, errId].filter(Boolean).join(" ") || undefined, invalid: !!error };
  const labelable = isLabelable(prop.control);
  return (
    <div className="item-prop">
      {labelable ? <label className="label" htmlFor={id}>{prop.label}</label> : <span className="label">{prop.label}</span>}
      <FieldControl control={prop.control} label={prop.label} value={value} onChange={(v) => onChange(v)} wiring={wiring} unit={prop.unit} schema={prop.schema} errors={sub} />
      {prop.help ? <p className="help" id={helpId}>{prop.help}</p> : null}
      {error ? <p className="help field-error" id={errId}>{error}</p> : null}
    </div>
  );
}

/** Renders the control for a key (or a card property) by its kind. */
export function FieldControl(p: ControlProps): ReactNode {
  const { control: c, wiring, value } = p;
  switch (c.kind) {
    case "switch":
      return <Switch label={<span className="sr-only">{p.label}</span>} checked={value === true} onChange={(v) => p.onChange(v)} describedBy={wiring.describedBy} disabled={p.disabled} />;
    case "segmented":
      return <SegmentedGroup legend={p.label} name={wiring.id} options={withExtra(c.options, [asString(value)].filter((v) => v !== ""))} value={asString(value)} onChange={(v) => p.onChange(v)} describedBy={wiring.describedBy} disabled={p.disabled} />;
    case "select": {
      const options = withExtra(c.options, [asString(value)].filter((v) => v !== ""));
      return (
        <select id={wiring.id} className="field" value={asString(value)} aria-describedby={wiring.describedBy} aria-invalid={wiring.invalid || undefined} onChange={(e) => p.onChange(e.target.value)}>
          {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      );
    }
    case "slider":
      return <Slider label={p.label} value={typeof value === "number" ? value : Number.NaN} onChange={(v) => p.onChange(v)} min={c.min} max={c.max} step={c.step} unit={p.unit} describedBy={wiring.describedBy} disabled={p.disabled} />;
    case "number":
      return <NumberBox value={value} onChange={(v) => p.onChange(v)} wiring={wiring} unit={p.unit} schema={p.schema} />;
    case "text":
    case "textarea": {
      const text = asString(value);
      const long = c.kind === "textarea" || [p.settled, p.schema.default, value].some((v) => typeof v === "string" && (v.length > 80 || v.includes("\n")));
      return long
        ? <textarea id={wiring.id} className="field" rows={4} value={text} aria-describedby={wiring.describedBy} aria-invalid={wiring.invalid || undefined} onChange={(e) => p.onChange(e.target.value)} />
        : <input id={wiring.id} className="field" type="text" value={text} placeholder={p.placeholder} autoComplete="off" spellCheck={false} aria-describedby={wiring.describedBy} aria-invalid={wiring.invalid || undefined} onChange={(e) => p.onChange(e.target.value)} />;
    }
    case "lines":
      return <LinesBox value={value} onChange={(v) => p.onChange(v)} wiring={wiring} />;
    case "chips":
      return <Chips legend={p.label} options={withExtra(c.options, asList(value))} values={asList(value)} onChange={(v) => p.onChange(v)} describedBy={wiring.describedBy} disabled={p.disabled} />;
    case "sources":
      return (
        <TilePicker legend={p.label} options={KNOWN_SOURCES} values={asList(value)} onChange={(v) => p.onChange(v)} addLabel="Add a connector tag"
          onAdd={(tag) => { const t = tag.trim().toLowerCase(); if (t && !asList(value).includes(t)) p.onChange([...asList(value), t]); }} describedBy={wiring.describedBy} />
      );
    case "timezone":
      return <TimezoneBox value={value} onChange={(v) => p.onChange(v)} wiring={wiring} />;
    case "model":
      return <ModelBox {...p} control={c} />;
    case "voice":
      return <VoicePicker label={p.label} value={asString(value)} onChange={(v) => p.onChange(v)} voices={p.voices === undefined ? [] : p.voices} unreachable="the voice server" help={p.help} />;
    case "objects":
      return <ObjectsEditor props={c.props} value={value} onChange={(v) => p.onChange(v)} label={p.label} wiring={wiring} errors={p.errors} />;
    case "json":
      return <JsonBox value={value} onChange={p.onChange} wiring={wiring} />;
    case "secret":
      return null; // a secret is rendered by the row (secrets.tsx), which owns its writes
  }
}
