import type { ReactNode } from "react";
import { Button } from "./Button";

/** An empty list: a title and one sentence of what to do or why. */
export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="state state-empty"><p className="state-title">{title}</p>{children ? <p className="muted small">{children}</p> : null}</div>;
}

/** A load in progress: a polite status, `aria-busy`. */
export function LoadingState({ label = "Loading…" }: { label?: string }) {
  return <div className="state state-loading" role="status" aria-busy="true">{label}</div>;
}

/** A failed load: an alert with the reason and a Retry button (earlier data stays on the screen around it). */
export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="state state-error" role="alert">
      <p>{message}</p>
      {onRetry ? <Button size="sm" onClick={onRetry}>Retry</Button> : null}
    </div>
  );
}
