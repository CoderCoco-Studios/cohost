import { useState } from "react";
import { Field } from "./Field";

const LANG: Record<string, string> = { a: "American", b: "British", e: "Spanish", f: "French", h: "Hindi", i: "Italian", j: "Japanese", p: "Brazilian Portuguese", z: "Mandarin" };

/** `af_heart` as `af_heart · American, female`, decoded from the id's two-letter prefix; an id of another shape is shown as is. */
export function voiceLabel(id: string): string {
  const m = /^([a-z])([fm])_/.exec(id);
  const lang = m ? LANG[m[1]!] : undefined;
  return lang ? `${id} · ${lang}, ${m![2] === "f" ? "female" : "male"}` : id;
}

const CUSTOM = "__custom_mix__";
const isBlend = (v: string) => /[+()]/.test(v);

export interface VoicePickerProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** The voice ids the voice server offers, or null when it could not be read (then the box is plain text). */
  voices: string[] | null;
  /** Names the server in the note shown when `voices` is null. */
  unreachable?: string;
  help?: React.ReactNode;
}

/**
 * A select of the voices the voice server offers, each labelled with its language and gender, and a "Custom mix…" entry
 * that opens a text box for a blend such as `af_bella(2)+af_sky` (DASH-SET-023). With the voice server unreachable it is
 * a text box holding the current value and a note (DASH-SET-010). A value the list lacks is an extra selected option.
 */
// @spec DASH-SET-023, DASH-SET-010
export function VoicePicker({ label, value, onChange, voices, unreachable, help }: VoicePickerProps) {
  const [custom, setCustom] = useState(isBlend(value));
  const [draft, setDraft] = useState(isBlend(value) ? value : ""); // the box starts empty: opening it does not change the saved voice
  if (voices === null) {
    return (
      <Field label={label} help={help}>
        {(p) => (<>
          <input {...p} className="field" type="text" value={value} autoComplete="off" spellCheck={false} onChange={(e) => onChange(e.target.value)} />
          <p className="help">{`Could not reach ${unreachable ?? "the voice server"}. Type the name instead.`}</p>
        </>)}
      </Field>
    );
  }
  const listed = voices.includes(value);
  return (
    <Field label={label} help={help}>
      {(p) => (<>
        <select {...p} className="field" value={custom ? CUSTOM : value}
          onChange={(e) => { if (e.target.value === CUSTOM) setCustom(true); else { setCustom(false); onChange(e.target.value); } }}>
          {!custom && !listed ? <option value={value}>{value}</option> : null}
          {voices.map((v) => <option key={v} value={v}>{voiceLabel(v)}</option>)}
          <option value={CUSTOM}>Custom mix{"…"}</option>
        </select>
        {custom ? <input className="field" type="text" aria-label="Custom mix" value={draft} placeholder="af_bella(2)+af_sky" autoComplete="off" spellCheck={false} onChange={(e) => { setDraft(e.target.value); onChange(e.target.value); }} /> : null}
      </>)}
    </Field>
  );
}
