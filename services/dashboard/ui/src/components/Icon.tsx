import type { SVGProps } from "react";

/** The inline SVG icons the UI uses. Every icon is decorative (`aria-hidden`): the control it sits in has a text label or an `aria-label` (DASH-A11Y-008). */
const PATHS = {
  external: "M14 3h7v7M21 3l-9 9M10 5H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5",
  check: "M5 12.5l4.5 4.5L19 7.5",
  close: "M6 6l12 12M18 6L6 18",
  lock: "M7 11V8a5 5 0 0 1 10 0v3M6 11h12v9H6z",
  unlock: "M7 11V8a5 5 0 0 1 9.5-2M6 11h12v9H6z",
  speaker: "M4 9v6h4l5 4V5L8 9zM16.5 8.5a5 5 0 0 1 0 7",
  speakerOff: "M4 9v6h4l5 4V5L8 9zM17 9l4 6M21 9l-4 6",
  mic: "M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM6 11a6 6 0 0 0 12 0M12 17v4",
  sun: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19",
  moon: "M20 14.5A8 8 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5z",
  info: "M12 8h.01M11 12h1v5h1M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z",
  keyboard: "M3 7h18v10H3zM7 11h.01M11 11h.01M15 11h.01M8 14h8",
  chevronDown: "M6 9l6 6 6-6",
} as const;
export type IconName = keyof typeof PATHS;

export function Icon({ name, ...rest }: { name: IconName } & Omit<SVGProps<SVGSVGElement>, "name">) {
  return (
    <svg className="icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...rest}>
      <path d={PATHS[name]} />
    </svg>
  );
}
