import type { ReactNode } from "react";

export interface Option { value: string; label: ReactNode }

export interface SegmentedGroupProps {
  /** The group's accessible name (visually hidden unless `showLegend`). */
  legend: string;
  name: string;
  options: Option[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  showLegend?: boolean;
}

/** A row of native radio buttons styled as segments: the keyboard (arrow keys) and the group semantics are the browser's. */
export function SegmentedGroup({ legend, name, options, value, onChange, disabled, showLegend }: SegmentedGroupProps) {
  return (
    <fieldset className="seg" disabled={disabled}>
      <legend className={showLegend ? "label" : "sr-only"}>{legend}</legend>
      {options.map((o) => (
        <label key={o.value}>
          <input type="radio" name={name} value={o.value} checked={o.value === value} onChange={() => onChange(o.value)} />
          <span className={o.value === value ? "on" : undefined}>{o.label}</span>
        </label>
      ))}
    </fieldset>
  );
}
