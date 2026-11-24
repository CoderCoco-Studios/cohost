// The model response's etag against the view's version (DASH-AVP-026). Pure.

/** The version an etag names: its `W/` prefix and its outer quotes removed, nothing else. */
// @spec DASH-AVP-026
export function etagVersion(etag: string): string {
  let v = etag.startsWith("W/") ? etag.slice(2) : etag;
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
  return v;
}

/** True when a response's etag names the version: the comparison is case-sensitive and an empty version never matches. */
// @spec DASH-AVP-026
export function etagMatches(etag: string | null, version: string): boolean {
  return etag !== null && version !== "" && etagVersion(etag) === version;
}
