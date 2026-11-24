import type { BusEvent } from "@cohost/bus";
import type { Config } from "@cohost/config";
import type { MemoryBackend } from "./store.js";
import { defaultHint, effectiveStrength, type NoteRow } from "./notes.js";
import { viewerKey } from "@cohost/shared/untrusted";

export type NotesReplyViewers = BusEvent<"memory.notes.reply">["data"]["viewers"];
/** One `memory.notes.request` entry: a name, with the platform and id when the cortex knows them. */
export type NotesEntry = BusEvent<"memory.notes.request">["data"]["viewers"][number];

/** What surfacing needs from a store. */
export type SurfaceStore = Pick<MemoryBackend, "findNameKeyedViewerByDisplay" | "getViewer" | "listNotes" | "markSurfaced">;

/**
 * The viewer row an entry names (MEM-SURF-002, MEM-SURF-006, MEM-SURF-007): by the `viewerKey` of its platform and id, by the
 * `viewerKey` of its platform and name, or, with no platform, by display name among the name-keyed rows only (MEM-SURF-006). A link's
 * `discord_display` is never a name key (MEM-VOICE-007).
 */
// @spec MEM-SURF-002, MEM-SURF-006, MEM-SURF-007, MEM-VOICE-007
async function resolveEntry(store: SurfaceStore, e: NotesEntry) {
  if (e.platform && e.userId) return store.getViewer(viewerKey({ platform: e.platform, userId: e.userId, user: e.user }));
  if (e.platform) return store.getViewer(viewerKey({ platform: e.platform, user: e.user }));
  return store.findNameKeyedViewerByDisplay(e.user);
}

const HOUR_MS = 3_600_000;
const isSensitive = (n: Pick<NoteRow, "category">): boolean => n.category !== "general";

// @spec MEM-SURF-001, MEM-SURF-002, MEM-SURF-003, MEM-SURF-004, MEM-SURF-006, MEM-SURF-007
/**
 * The notes the cortex gets for a reply: one entry per request entry that resolves to a viewer, in request order. The first
 * entry is the viewer replied to; the rest are other viewers in the cortex's window. Throws when the store fails
 * (the region answers an empty list, MEM-SURF-005).
 */
export async function buildNotesReply(
  store: SurfaceStore,
  cfg: Config["brain"]["memory"],
  entries: readonly NotesEntry[],
  now: number,
): Promise<NotesReplyViewers> {
  const n = cfg.notes;
  const out: NotesReplyViewers = [];
  const seen = new Set<string>();
  const surfaced: number[] = [];
  let budget = n.max_notes_total;
  for (const [i, entry] of entries.entries()) {
    const viewer = await resolveEntry(store, entry);
    if (!viewer || seen.has(viewer.key)) continue; // unknown names are omitted; a viewer is listed once
    seen.add(viewer.key);
    const repliedTo = i === 0;
    const ranked = (await store.listNotes(viewer.key))
      .map((row) => ({ row, strength: effectiveStrength(row, now, n) }))
      .filter((c) => c.strength >= n.drop_below) // faded but not yet deleted by a pass: never sent
      .filter((c) => !isSensitive(c.row) || (repliedTo && cooledDown(c.row, now, n.sensitive_cooldown_hours)))
      .sort((a, b) => b.strength - a.strength || a.row.id - b.row.id)
      .slice(0, Math.max(0, Math.min(n.max_notes_per_viewer, budget)));
    budget -= ranked.length;
    for (const { row } of ranked) if (isSensitive(row)) surfaced.push(row.id);
    out.push({
      user: viewer.display,
      ...(entry.platform ? { platform: entry.platform } : {}),
      ...(entry.userId ? { userId: entry.userId } : {}),
      regular: viewer.regular,
      msgCount: viewer.msgCount,
      notes: ranked.map(({ row, strength }) => {
        const sensitive = isSensitive(row);
        const hint = row.hint ?? (sensitive ? defaultHint(row.category) : undefined);
        return {
          layer: row.layer,
          category: row.category,
          // Health and family notes leave memory as a handling hint only: the text never travels to the cortex.
          ...(sensitive ? {} : { text: row.text }),
          ...(hint ? { hint } : {}),
          strength,
        };
      }),
    });
  }
  // Recorded before the reply is sent: a failure here answers an empty list rather than showing a hint unrecorded.
  await store.markSurfaced(surfaced, new Date(now));
  return out;
}

/** A sensitive note goes out at most once per cooldown, per note. */
function cooledDown(note: Pick<NoteRow, "lastSurfacedAt">, now: number, cooldownHours: number): boolean {
  return !note.lastSurfacedAt || now - note.lastSurfacedAt.getTime() >= cooldownHours * HOUR_MS;
}
