import type { ReactNode } from "react";

export type Tone = "info" | "ok" | "warn" | "bad" | "build";

/** A note block in a tone. A `bad` banner is an alert (announced at once); the others are a polite status region. */
export function Banner({ tone = "info", title, children, actions }: { tone?: Tone; title?: ReactNode; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className={`note${tone === "info" ? "" : ` note-${tone}`}`} role={tone === "bad" ? "alert" : "status"}>
      {title ? <strong className="note-title">{title}</strong> : null}
      {children}
      {actions ? <div className="row note-actions">{actions}</div> : null}
    </div>
  );
}
