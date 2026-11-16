import { useId, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";

/** The attributes a control inside a `Field` must spread: its id (the label's target) and the help and error references. */
export interface FieldControlProps {
  id: string;
  "aria-describedby"?: string;
  "aria-invalid"?: true;
}

export interface FieldProps {
  label: ReactNode;
  help?: ReactNode;
  /** The validation message; marks the control `aria-invalid` and is announced through `aria-describedby`. */
  error?: ReactNode;
  className?: string;
  children: (props: FieldControlProps) => ReactNode;
}

/**
 * A label, a control and its help and error text, wired for assistive technology: `<label for>`, `aria-describedby`
 * naming the help and the error, `aria-invalid` while there is an error (DASH-A11Y-003). The control is a render
 * prop so any native element can sit in it: `<Field label="Port">{(p) => <input {...p} className="field" />}</Field>`.
 */
// @spec DASH-A11Y-003
export function Field({ label, help, error, className, children }: FieldProps) {
  const id = useId();
  const helpId = help ? `${id}-help` : undefined, errorId = error ? `${id}-error` : undefined;
  const describedBy = [helpId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <div className={className}>
      <label className="label" htmlFor={id}>{label}</label>
      {children({ id, "aria-describedby": describedBy, ...(error ? { "aria-invalid": true as const } : {}) })}
      {help ? <p className="help" id={helpId}>{help}</p> : null}
      {error ? <p className="help field-error" id={errorId}>{error}</p> : null}
    </div>
  );
}

type TextProps = Omit<FieldProps, "children"> & { value: string; onChange: (value: string) => void };

/** A controlled single-line text box in a `Field`. Extra input attributes (`type`, `inputMode`, `placeholder`, `autoComplete`) pass through. */
export function TextField({ label, help, error, className, value, onChange, ...input }: TextProps & Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "className">) {
  return <Field label={label} help={help} error={error} className={className}>{(p) => <input {...input} {...p} className="field" value={value} onChange={(e) => onChange(e.target.value)} />}</Field>;
}

/** A controlled multi-line text area in a `Field`. */
export function TextAreaField({ label, help, error, className, value, onChange, ...area }: TextProps & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange" | "className">) {
  return <Field label={label} help={help} error={error} className={className}>{(p) => <textarea {...area} {...p} className="field" value={value} onChange={(e) => onChange(e.target.value)} />}</Field>;
}
