import type { BusEvent } from "@cohost/bus";
import { VOICE_PREFIX, effectiveStrength, isVoiceKey, type DeletionRow, type NoteRow, type NotesConfig, type ViewerSummary } from "./notes.js";
import type { MemoryBackend } from "./store.js";

/** What the owner operations need from a store. */
export type ViewersAdminStore = Pick<
  MemoryBackend,
  "listViewers" | "getViewer" | "listNotes" | "listDeletions" | "deleteNote" | "restoreDeletion" | "clearNotes" | "setRegular"
  | "linkDiscord" | "unlinkDiscord" | "listLinks"
>;

export type ViewersRequest = BusEvent<"memory.viewers.request">["data"];
export type ViewersAnswer = Omit<BusEvent<"memory.viewers.reply">["data"], "id">;

const LIST_LIMIT = 500;

class NotFound extends Error {}
const notFound = (what: string): never => { throw new NotFound(what); };

/** A bus id string as a store id; anything that is not a plain integer names no row. */
const idOf = (s: string): number | undefined => (/^\d{1,15}$/.test(s) ? Number(s) : undefined);

const viewerData = (v: ViewerSummary | (Omit<ViewerSummary, "noteCount"> & { noteCount?: number })) => ({
  key: v.key, display: v.display, regular: v.regular, regularManual: v.regularManual, msgCount: v.msgCount,
  ...(v.noteCount === undefined ? {} : { noteCount: v.noteCount }),
  // @spec MEM-VOICE-009
  ...(isVoiceKey(v.key) ? { voice: true, discordId: v.key.slice(VOICE_PREFIX.length) } : {}),
});

const noteData = (n: NoteRow, now: number, cfg: NotesConfig) => ({
  id: String(n.id), layer: n.layer, category: n.category, text: n.text, hint: n.hint, strength: effectiveStrength(n, now, cfg),
});

const deletionData = (d: DeletionRow) => ({
  id: String(d.id), layer: d.layer, category: d.category, text: d.text, hint: d.hint, reason: d.reason, deletedAt: d.deletedAt.getTime(),
});

// @spec MEM-ADMIN-001, MEM-ADMIN-002, MEM-ADMIN-003, MEM-ADMIN-004, MEM-ADMIN-005, MEM-ADMIN-006, MEM-ADMIN-007, MEM-VOICE-005, MEM-VOICE-006, MEM-VOICE-009
/**
 * Runs one owner operation from the dashboard's Viewers page and returns the reply's `ok` / `data` / `error`.
 * A missing viewer, note or deletion record is `not_found`; any other failure is `failed` with the error text.
 */
export async function answerViewersRequest(store: ViewersAdminStore, notes: NotesConfig, req: ViewersRequest, now: number = Date.now()): Promise<ViewersAnswer> {
  try {
    return { ok: true, data: await run(store, notes, req, now) };
  } catch (err) {
    if (err instanceof NotFound) return { ok: false, error: "not_found", detail: err.message };
    return { ok: false, error: "failed", detail: String(err) };
  }
}

async function run(store: ViewersAdminStore, notes: NotesConfig, req: ViewersRequest, now: number): Promise<unknown> {
  switch (req.op) {
    case "list": {
      const viewers = await store.listViewers({ query: req.query, limit: LIST_LIMIT });
      return { viewers: viewers.map(viewerData) };
    }
    case "get": {
      const v = await store.getViewer(req.key);
      if (!v) return notFound(`no viewer ${req.key}`);
      const [stored, deletions, links] = await Promise.all([store.listNotes(v.key), store.listDeletions(v.key), store.listLinks(v.key)]);
      const strongestFirst = (a: NoteRow, b: NoteRow) => effectiveStrength(b, now, notes) - effectiveStrength(a, now, notes) || a.id - b.id;
      const sorted = [...stored].sort(strongestFirst);
      return {
        viewer: viewerData({ ...v, noteCount: stored.length }),
        core: sorted.filter((n) => n.layer === "core").map((n) => noteData(n, now, notes)),
        recent: sorted.filter((n) => n.layer === "recent").map((n) => noteData(n, now, notes)),
        deletions: deletions.map(deletionData).reverse(), // newest first
        ...(links.length ? { links } : {}),
      };
    }
    case "delete_note": {
      const id = idOf(req.noteId);
      if (id === undefined || !(await store.deleteNote(id, req.reason))) return notFound(`no note ${req.noteId}`);
      return {};
    }
    case "restore": {
      const id = idOf(req.deletionId);
      const note = id === undefined ? undefined : await store.restoreDeletion(id);
      if (!note) return notFound(`no deleted note ${req.deletionId}`);
      return { note: noteData(note, now, notes) };
    }
    case "clear": {
      if (!(await store.getViewer(req.key))) return notFound(`no viewer ${req.key}`);
      return { cleared: await store.clearNotes(req.key, req.reason) };
    }
    case "link_discord": {
      const who = (req.key?.trim() || req.name?.trim()) ?? "";
      const out = who ? await store.linkDiscord(req.discordId, who) : undefined;
      if (!out) return notFound(`no chat viewer ${who}`.trim());
      return { viewer: viewerData(out.viewer), moved: out.moved };
    }
    case "unlink_discord": {
      if (!(await store.unlinkDiscord(req.discordId))) return notFound(`no link for ${req.discordId}`);
      return {};
    }
    case "set_regular": {
      const who = req.key?.trim() || req.name?.trim();
      const v = who ? await store.setRegular(who, req.regular) : undefined;
      if (!v) return notFound(`no viewer ${who ?? ""}`.trim());
      return { viewer: viewerData(v) };
    }
  }
}
