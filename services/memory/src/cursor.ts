/** The reflection cursor: the `(ts, id)` of the newest memory a reflection read. */
export interface ReflectCursor {
  /** ISO-8601 UTC text at the precision it was read with (Postgres: microseconds), so it round-trips exactly. */
  ts: string;
  id: number;
}

/** Before the first row: every real row (ids start at 1) is strictly after it. */
export const START_CURSOR: ReflectCursor = { ts: "1970-01-01T00:00:00.000Z", id: 0 };

// @spec MEM-REFLECT-008
/** `meta.last_reflection` is `<ISO ts>#<id>`; a legacy plain ISO timestamp reads as that ts with the lowest id. */
export function parseCursor(v: string | undefined): ReflectCursor {
  if (!v) return START_CURSOR;
  const [ts, id] = v.split("#");
  if (!ts || Number.isNaN(new Date(ts).getTime())) return START_CURSOR;
  return { ts, id: id === undefined ? 0 : Number(id) || 0 };
}

export function formatCursor(c: ReflectCursor): string {
  return `${c.ts}#${c.id}`;
}
