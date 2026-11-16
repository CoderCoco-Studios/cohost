import { useId, useState, type ReactNode } from "react";
import { Button } from "./Button";

export interface Tile { value: string; label: ReactNode; description?: ReactNode }

export interface TilePickerProps {
  legend: string;
  options: Tile[];
  values: string[];
  onChange: (values: string[]) => void;
  /** Label of the add-your-own field; with `onAdd`, shows the add tile. */
  addLabel?: string;
  onAdd?: (tag: string) => void;
  /** Id of the element holding the picker's help text (`aria-describedby`). */
  describedBy?: string;
}

/**
 * Choose several from a small known set: a grid of whole-area checkbox tiles with a name and one line of description,
 * and, when `onAdd` is given, a dashed tile with a text box and Add button for a value not in the list.
 */
export function TilePicker({ legend, options, values, onChange, addLabel, onAdd, describedBy }: TilePickerProps) {
  const [draft, setDraft] = useState("");
  const addId = useId();
  const known = new Set(options.map((o) => o.value));
  const extra = values.filter((v) => !known.has(v)).map((v) => ({ value: v, label: v }) as Tile);
  const toggle = (v: string, on: boolean) => onChange(on ? [...values, v] : values.filter((x) => x !== v));
  const add = () => { const t = draft.trim(); if (t && onAdd) { onAdd(t); setDraft(""); } };
  return (
    <fieldset className="tiles" aria-describedby={describedBy}>
      <legend className="sr-only">{legend}</legend>
      {[...options, ...extra].map((o) => {
        const on = values.includes(o.value);
        return (
          <label key={o.value} className={`tile${on ? " on" : ""}`}>
            <input type="checkbox" checked={on} onChange={(e) => toggle(o.value, e.target.checked)} />
            <span className="tick" aria-hidden="true">{on ? "✓" : ""}</span>
            <b>{o.label}</b>
            {o.description ? <span className="small">{o.description}</span> : null}
          </label>
        );
      })}
      {onAdd && addLabel ? (
        <div className="tile tile-add">
          <label className="sr-only" htmlFor={addId}>{addLabel}</label>
          <input id={addId} className="field" value={draft} placeholder={addLabel} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }} />
          <Button size="sm" onClick={add} disabled={!draft.trim()}>Add</Button>
        </div>
      ) : null}
    </fieldset>
  );
}
