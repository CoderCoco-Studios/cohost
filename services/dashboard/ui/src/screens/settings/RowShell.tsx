import type { ReactNode } from "react";

/** One setting's row: the label and key path, the control column and the source (design: Rows and groups). */
export function RowShell({ section, name, path, label, labelFor, hideLabel, source, children }: {
  section: string; name: string; path: string; label: string;
  /** The id of the control the label names, when a `<label for>` can; otherwise the label is plain text. */
  labelFor?: string;
  /** The control brings its own label; the visible one here is not read twice. */
  hideLabel?: boolean;
  source: string; children: ReactNode;
}) {
  return (
    <div className="srow" data-key={name} data-section={section}>
      <div className="srow-l">
        {labelFor ? <label className="label" htmlFor={labelFor}>{label}</label> : <span className="label" aria-hidden={hideLabel || undefined}>{label}</span>}
        <code className="mono wrap">{path}</code>
      </div>
      <div className={`srow-c stack-y${hideLabel ? " embedded" : ""}`}>{children}</div>
      <div className="srow-s"><span className="tag">{source}</span></div>
    </div>
  );
}
