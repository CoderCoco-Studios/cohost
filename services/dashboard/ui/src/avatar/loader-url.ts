// What the page may load and the URL it asks for a model (DASH-AVP-004, DASH-AVP-008). Pure.

/** True for a `data:` or `blob:` URL, the only kinds the model loader may request (DASH-AVP-008). The scheme is case-insensitive and nothing may precede it. */
// @spec DASH-AVP-008
export function isLoaderUrlAllowed(url: string): boolean {
  return /^(?:data|blob):/i.test(url);
}

/** Where a model comes from: the applied one, or a preview's draft by its stored name. */
export type ModelSource = { kind: "applied" } | { kind: "draft"; name: string };

/**
 * The URL of a model. A stored name is one path segment, percent-encoded, so no character of it can change the path or add
 * a query or fragment. A name made only of dots would be a dot segment the URL parser removes (`..` climbs), so it is
 * written with a leading `%20` and its dots escaped; the server reads that as a name that no stored file has.
 */
// @spec DASH-AVP-004, DASH-AVP-036
export function modelUrl(src: ModelSource): string {
  if (src.kind === "applied") return "/avatar/model";
  const seg = /^\.+$/.test(src.name) ? `%20${src.name.replace(/\./g, "%2E")}` : encodeURIComponent(src.name);
  return `/avatar/models/${seg}`;
}
