import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from "react";

export type ButtonVariant = "default" | "primary" | "danger" | "ghost";
const cls = (variant: ButtonVariant, size?: "sm", extra?: string): string =>
  ["btn", variant !== "default" && `btn-${variant}`, size === "sm" && "btn-sm", extra].filter(Boolean).join(" ");

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: "sm";
  /** A request is in flight: the button is disabled and `aria-busy`. */
  busy?: boolean;
  children?: ReactNode;
}

/** A native `<button type="button">` in one of four variants. Use `aria-pressed` for a toggle button. */
export function Button({ variant = "default", size, busy, className, disabled, children, ...rest }: ButtonProps) {
  return (
    <button type="button" {...rest} className={cls(variant, size, className)} disabled={disabled || busy} aria-busy={busy || undefined}>
      {children}
    </button>
  );
}

/** A real link that looks like a button (the header's Docs link, a "How to read" link). */
export function ButtonLink({ variant = "default", size, className, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { variant?: ButtonVariant; size?: "sm" }) {
  return <a {...rest} className={cls(variant, size, className)}>{children}</a>;
}
