/**
 * The co-host's name, delivered in `<meta name="cohost-name">` by the dashboard server (HTML-escaped there, DASH-HTTP-001).
 * An unreplaced placeholder (the Vite dev server serves the template as is) or an empty value reads as "cohost".
 */
// @spec DASH-HTTP-001
export function cohostName(doc: Document = document): string {
  const v = doc.querySelector('meta[name="cohost-name"]')?.getAttribute("content")?.trim();
  return v && v !== "__COHOST_NAME__" ? v : "cohost";
}
