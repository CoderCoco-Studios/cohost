/** Wire types of the `/viewers` routes (memory's `viewers.request` replies, passed through by the dashboard). */
export interface ViewerSummary {
  key: string;
  display: string;
  regular: boolean;
  /** The owner's "always a regular" flag. */
  regularManual: boolean;
  msgCount: number;
  noteCount?: number;
  voice?: boolean;
  discordId?: string;
}

export interface NoteData {
  id: string;
  layer: "core" | "recent";
  category: string;
  text: string;
  hint: string | null;
  /** 0 to 1. */
  strength: number;
}

export interface DeletionData {
  id: string;
  layer: "core" | "recent";
  category: string;
  text: string;
  hint: string | null;
  reason: string | null;
  deletedAt: number;
}

export interface LinkData { discordId: string; discordDisplay?: string | null }

export interface ViewerDetailData {
  viewer: ViewerSummary;
  core: NoteData[];
  recent: NoteData[];
  deletions: DeletionData[];
  links?: LinkData[];
}
