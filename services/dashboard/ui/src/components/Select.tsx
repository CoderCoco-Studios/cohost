import { Field, type FieldProps } from "./Field";
import type { Option } from "./SegmentedGroup";

type SelectOption = { value: string; label: string };

/**
 * A native `<select>` in a `Field`. A current value the options do not list (an old config file) is shown as an extra
 * selected option and never dropped (DASH-SET-013).
 */
// @spec DASH-SET-017, DASH-SET-013
export function Select({ label, help, error, className, value, onChange, options }: Omit<FieldProps, "children"> & { value: string; onChange: (value: string) => void; options: SelectOption[] }) {
  const listed = options.some((o) => o.value === value);
  return (
    <Field label={label} help={help} error={error} className={className}>
      {(p) => (
        <select {...p} className="field" value={value} onChange={(e) => onChange(e.target.value)}>
          {listed ? null : <option value={value}>{value}</option>}
          {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      )}
    </Field>
  );
}
export type { Option };
