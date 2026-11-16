import type { Option } from "./SegmentedGroup";

export interface ChipsProps {
  legend: string;
  options: Option[];
  values: string[];
  onChange: (values: string[]) => void;
  disabled?: boolean;
  /** Id of the element holding the group's help text (`aria-describedby`). */
  describedBy?: string;
}

/** One toggle pill per value: a group of native checkboxes whose on state shows as a filled pill with a tick. */
export function Chips({ legend, options, values, onChange, disabled, describedBy }: ChipsProps) {
  const toggle = (v: string, on: boolean) => onChange(on ? [...values, v] : values.filter((x) => x !== v));
  return (
    <fieldset className="chips" disabled={disabled} aria-describedby={describedBy}>
      <legend className="sr-only">{legend}</legend>
      {options.map((o) => {
        const on = values.includes(o.value);
        return (
          <label key={o.value} className={`chip${on ? " on" : ""}`}>
            <input type="checkbox" checked={on} onChange={(e) => toggle(o.value, e.target.checked)} />
            <span className="tick" aria-hidden="true">{on ? "✓" : ""}</span>
            {o.label}
          </label>
        );
      })}
    </fieldset>
  );
}
