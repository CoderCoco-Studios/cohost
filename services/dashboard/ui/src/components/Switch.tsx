import { useId, type ReactNode } from "react";

export interface SwitchProps {
  label: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /** Associates help text (`aria-describedby`). */
  describedBy?: string;
}

/**
 * A native checkbox with `role="switch"`: a track with a coloured on state and the word On or Off beside it, so the
 * state never depends on colour (DASH-SET-016). The label is the accessible name; the word is the visible state.
 */
// @spec DASH-SET-016
export function Switch({ label, checked, onChange, disabled, describedBy }: SwitchProps) {
  const id = useId();
  return (
    <label className="check">
      <input type="checkbox" role="switch" className="switch" checked={checked} disabled={disabled} aria-labelledby={id} aria-describedby={describedBy} onChange={(e) => onChange(e.target.checked)} />
      <span id={id}>{label}</span>
      <span className={`switch-word${checked ? " on-text" : ""}`} aria-hidden="true">{checked ? "On" : "Off"}</span>
    </label>
  );
}
