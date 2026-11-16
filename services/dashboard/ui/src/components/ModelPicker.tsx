import { useId } from "react";
import { Field } from "./Field";

export interface ModelPickerProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** The models the model server reports installed; listed first. */
  installed?: string[];
  /** A curated list for the model's kind; listed after the installed ones. */
  curated?: string[];
  placeholder?: string;
  help?: React.ReactNode;
  /** Set when the pick list could not be read: names the server in the note under the box. */
  unreachable?: string;
}

/**
 * A free-text box with suggestions: the installed models first, then the curated ones, no duplicates, any typed name
 * accepted (DASH-SET-022). The screen fetches the lists and passes them in; with none, it is just the box, plus a note
 * naming the server it could not reach (DASH-SET-010).
 */
// @spec DASH-SET-022, DASH-SET-010
export function ModelPicker({ label, value, onChange, installed = [], curated = [], placeholder, help, unreachable }: ModelPickerProps) {
  const listId = useId();
  const options = [...new Set([...installed, ...curated])];
  return (
    <Field label={label} help={help}>
      {(p) => (
        <>
          <input {...p} className="field" type="text" value={value} placeholder={placeholder} list={options.length ? listId : undefined} autoComplete="off" spellCheck={false} onChange={(e) => onChange(e.target.value)} />
          {options.length ? <datalist id={listId}>{options.map((o) => <option key={o} value={o} />)}</datalist> : null}
          {unreachable ? <p className="help">{`Could not reach ${unreachable}. Type the name instead.`}</p> : null}
        </>
      )}
    </Field>
  );
}
