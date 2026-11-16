import { useId, type CSSProperties } from "react";

export interface SliderProps {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  /** Printed beside the number box ("dB", "ms"). */
  unit?: string;
  disabled?: boolean;
  describedBy?: string;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * A styled range slider with both end values printed and an exact number box beside it, kept in step (DASH-SET-018).
 * The filled share of the track is the one computed inline style the UI allows (`--p`, DASH-THEME-006). A number typed
 * outside the range is passed on as typed (the screen validates it), marked `aria-invalid`, and the thumb stops at the end.
 */
// @spec DASH-SET-018, DASH-THEME-006
export function Slider({ label, value, onChange, min, max, step = 1, unit, disabled, describedBy }: SliderProps) {
  const id = useId();
  const finite = Number.isFinite(value);
  const shown = finite ? clamp(value, min, max) : min;
  const pct = max > min ? ((shown - min) / (max - min)) * 100 : 0;
  const invalid = !finite || value < min || value > max;
  return (
    <div className="range-wrap">
      <span className="end" aria-hidden="true">{min}</span>
      <input id={id} type="range" className="range" min={min} max={max} step={step} value={shown} disabled={disabled} aria-label={label} aria-describedby={describedBy}
        style={{ "--p": `${pct}%` } as CSSProperties} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="end" aria-hidden="true">{max}</span>
      <input type="number" className="field num" min={min} max={max} step={step} inputMode="decimal" value={Number.isFinite(value) ? value : ""} disabled={disabled}
        aria-label={`${label} value`} aria-invalid={invalid || undefined} aria-describedby={describedBy}
        onChange={(e) => onChange(e.target.value === "" ? Number.NaN : Number(e.target.value))} />
      {unit ? <span className="small muted">{unit}</span> : null}
    </div>
  );
}
