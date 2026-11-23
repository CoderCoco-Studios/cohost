import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, rename, unlink, type FileHandle } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { dataDir, RENDERER_MODEL_NAME } from "@cohost/config";

/** Stored models per folder (DASH-MDL-020). */
export const MODEL_MAX_COUNT = 20;
/** Stored bytes per folder, all models together (DASH-MDL-020). */
export const MODEL_MAX_TOTAL_BYTES = 2147483648;
/** The longest stored file name, `.vrm` included (CFG-SCH-098). */
export const MODEL_NAME_MAX = 80;
/** The largest JSON chunk the head check reads (DASH-MDL-012, DASH-MDL-024). */
export const JSON_CHUNK_MAX = 16 * 1024 * 1024;
/** The metadata strings are cut at this many characters (DASH-MDL-013). */
const TEXT_MAX = 500;
/** The most expression names a model may list (DASH-MDL-013). */
const EXPRESSIONS_MAX = 256;
/** The longest stem a derived name keeps: 76 characters and `.vrm` make the 80 of the grammar. */
const MODEL_STEM_MAX = MODEL_NAME_MAX - 4;
const INCOMING = ".incoming-";
const JSON_CHUNK_TYPE = 0x4e4f534a;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/** The extensions a stored model may require (DASH-MDL-026). */
export const SUPPORTED_EXTENSIONS: ReadonlySet<string> = new Set([
  "VRM", "VRMC_vrm", "VRMC_springBone", "VRMC_node_constraint", "VRMC_materials_mtoon", "VRMC_materials_hdr_emissiveMultiplier",
  "KHR_materials_unlit", "KHR_materials_emissive_strength", "KHR_texture_transform", "KHR_mesh_quantization", "EXT_texture_webp",
]);
/** Compression the renderer bundles no decoder for (DASH-MDL-025). */
const UNDECODABLE: ReadonlySet<string> = new Set(["KHR_draco_mesh_compression", "KHR_texture_basisu", "EXT_meshopt_compression"]);

/** VRM 0.x preset names to their VRM 1.0 expression names (DASH-AVP-009). */
const PRESET_0X: Readonly<Record<string, string>> = {
  neutral: "neutral", a: "aa", i: "ih", u: "ou", e: "ee", o: "oh", joy: "happy", angry: "angry", sorrow: "sad", fun: "relaxed",
  blink: "blink", blink_l: "blinkLeft", blink_r: "blinkRight", lookup: "lookUp", lookdown: "lookDown", lookleft: "lookLeft", lookright: "lookRight",
};

/** The permission fields of each VRM version, with the usage label each shows under (DASH-MDL-013). */
const USAGE_1X: readonly [field: string, label: string][] = [
  ["avatarPermission", "Allowed users"], ["commercialUsage", "Commercial use"], ["creditNotation", "Credit"], ["modification", "Modification"],
  ["redistribution", "Redistribution"], ["allowExcessivelyViolentUsage", "Violent use"], ["allowExcessivelySexualUsage", "Sexual use"],
  ["allowPoliticalOrReligiousUsage", "Political or religious use"], ["allowAntisocialOrHateUsage", "Antisocial or hateful use"],
];
const USAGE_0X: readonly [field: string, label: string][] = [
  ["allowedUserName", "Allowed users"], ["commercialUssageName", "Commercial use"], ["violentUssageName", "Violent use"], ["sexualUssageName", "Sexual use"],
];

export interface Usage { label: string; value: string }
export interface Meta {
  vrm: "0" | "1";
  title: string;
  authors: string[];
  license: { name: string | null; url: string | null };
  usage: Usage[];
  expressions: string[];
}

/** A stored model as the store knows it: its file, and either its metadata or why its head failed. */
export interface Stored {
  name: string;
  path: string;
  bytes: number;
  /** Epoch milliseconds, rounded down. */
  modified: number;
  /** `<size hex>-<modified ms hex>`: the etag of DASH-MDL-004 without `W/"` and `"`. */
  version: string;
  meta?: Meta;
  error?: string;
}

/** What `judgeHead` decides about the bytes it has: more are needed, the head fails, or it passes. */
export type HeadVerdict =
  | { need: number }
  | { error: string }
  | { ok: true; total: number; meta: Meta };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** The first 500 code points of a string, walked and stopped at the limit (DASH-MDL-013). */
const cut = (s: string): string => {
  let out = "";
  let n = 0;
  for (const ch of s) {
    if (n === TEXT_MAX) break;
    out += ch;
    n++;
  }
  return out;
};
const text = (v: unknown): string | null => (typeof v === "string" ? cut(v) : null);
const eqIC = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const byNameIC = (a: { name: string }, b: { name: string }): number => {
  const x = a.name.toLowerCase(), y = b.name.toLowerCase();
  return x < y ? -1 : x > y ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
};

/** The grammar of a stored file name (DASH-MDL-002): `renderer.model`'s grammar and its length. */
export const modelNameOk = (name: string): boolean => name.length <= MODEL_NAME_MAX && RENDERER_MODEL_NAME.test(name);

/** Two names that differ only in ASCII case are one name (DASH-MDL-003). */
export const sameModel = (a: string, b: string): boolean => eqIC(a, b);

/** The folder the models live in (DASH-MDL-001). */
export const modelsDir = (): string => join(dataDir(), "dashboard", "avatar-models");

/**
 * The stored name for an upload's `name` query (DASH-MDL-018): last path segment (a backslash splits as well as a slash),
 * NFC, `.vrm` removed in any case, characters outside the grammar as `_`, leading non-alphanumerics removed, the stem cut to
 * 76 characters, `model` when empty, and `.vrm` appended.
 */
// @spec DASH-MDL-018
export function derivedName(query: string): string {
  const last = query.split(/[\\/]/).pop() ?? "";
  let stem = last.normalize("NFC").replace(/\.vrm$/i, "").replace(/[^A-Za-z0-9 _.-]/g, "_").replace(/^[^A-Za-z0-9]+/, "");
  stem = Array.from(stem).slice(0, MODEL_STEM_MAX).join("");
  return `${stem || "model"}.vrm`;
}

/**
 * Judges the glTF binary head held in `buf`, as far as it reaches (DASH-MDL-024 to DASH-MDL-026): the magic, version 2, the
 * first chunk the JSON chunk within 16 MiB, parseable JSON naming a VRM extension with its object present, no required or
 * undecodable extension outside the supported list, and no buffer or image that refers to a file. `need` is how many bytes
 * the verdict must see before it can decide. Reads only the JSON chunk, never the geometry.
 */
// @spec DASH-MDL-012, DASH-MDL-024, DASH-MDL-025, DASH-MDL-026
export function judgeHead(buf: Buffer): HeadVerdict {
  if (buf.length < 4) return { need: 12 };
  if (buf.toString("latin1", 0, 4) !== "glTF") return { error: "not a glTF binary: the magic is not glTF" };
  if (buf.length < 8) return { need: 12 };
  if (buf.readUInt32LE(4) !== 2) return { error: "the glTF version is not 2" };
  if (buf.length < 12) return { need: 12 };
  const total = buf.readUInt32LE(8);
  if (buf.length < 20) return { need: 20 };
  if (buf.readUInt32LE(16) !== JSON_CHUNK_TYPE) return { error: "the first chunk is not the JSON chunk" };
  const len = buf.readUInt32LE(12);
  if (len > JSON_CHUNK_MAX) return { error: "the JSON chunk is over 16 MiB" };
  if (buf.length < 20 + len) return { need: 20 + len };
  let parsed: unknown;
  try { parsed = JSON.parse(buf.toString("utf8", 20, 20 + len)); } catch { return { error: "the JSON chunk does not parse" }; }
  if (!isObj(parsed)) return { error: "the JSON chunk is not an object" };
  const used = Array.isArray(parsed["extensionsUsed"]) ? (parsed["extensionsUsed"] as unknown[]).filter((e): e is string => typeof e === "string") : [];
  const exts = isObj(parsed["extensions"]) ? parsed["extensions"] : {};
  const v1 = used.includes("VRMC_vrm") && isObj(exts["VRMC_vrm"]);
  const v0 = used.includes("VRM") && isObj(exts["VRM"]);
  if (!v1 && !v0) return { error: "no VRMC_vrm or VRM extension is listed in extensionsUsed with its object present" };
  const required = Array.isArray(parsed["extensionsRequired"]) ? (parsed["extensionsRequired"] as unknown[]) : [];
  for (const e of required) if (typeof e !== "string" || !SUPPORTED_EXTENSIONS.has(e)) return { error: `extensionsRequired names ${String(e)}, which the renderer does not load` };
  for (const e of used) if (UNDECODABLE.has(e)) return { error: `${e} is not loaded: the renderer bundles no decoder for it` };
  for (const key of ["buffers", "images"] as const) {
    const list = parsed[key];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (isObj(item) && item["uri"] !== undefined && !(typeof item["uri"] === "string" && item["uri"].startsWith("data:"))) {
        return { error: `a ${key === "buffers" ? "buffer" : "image"} refers to a file outside the model` };
      }
    }
  }
  return { ok: true, total, meta: describe(parsed, v1 ? "1" : "0", exts) };
}

/** The metadata of a judged head, normalised from the VRM 1.0 or 0.x `meta` (DASH-MDL-011 to DASH-MDL-013). */
export function describe(json: Record<string, unknown>, vrm: "0" | "1", exts: Record<string, unknown> = isObj(json["extensions"]) ? json["extensions"] : {}): Meta {
  const ext = isObj(exts[vrm === "1" ? "VRMC_vrm" : "VRM"]) ? (exts[vrm === "1" ? "VRMC_vrm" : "VRM"] as Record<string, unknown>) : {};
  const meta = isObj(ext["meta"]) ? (ext["meta"] as Record<string, unknown>) : {};
  const usage: Usage[] = [];
  const fields = vrm === "1" ? USAGE_1X : USAGE_0X;
  for (const [field, label] of fields) {
    const v = meta[field];
    if (typeof v === "boolean") usage.push({ label, value: v ? "Allowed" : "Not allowed" });
    else if (typeof v === "string") usage.push({ label, value: cut(v) });
  }
  if (vrm === "1") {
    const ex = isObj(ext["expressions"]) ? ext["expressions"] : {};
    const names = [...Object.keys(isObj(ex["preset"]) ? ex["preset"] : {}), ...Object.keys(isObj(ex["custom"]) ? ex["custom"] : {})];
    return {
      vrm, title: text(meta["name"]) ?? "",
      authors: strings(meta["authors"]),
      license: { name: null, url: text(meta["licenseUrl"]) },
      usage, expressions: unique(names),
    };
  }
  const master = isObj(ext["blendShapeMaster"]) ? ext["blendShapeMaster"] : {};
  const groups = Array.isArray(master["blendShapeGroups"]) ? (master["blendShapeGroups"] as unknown[]) : [];
  const names = groups.flatMap((g) => {
    if (!isObj(g) || typeof g["name"] !== "string") return [];
    const preset = typeof g["presetName"] === "string" && Object.hasOwn(PRESET_0X, g["presetName"]) ? PRESET_0X[g["presetName"]] : undefined;
    return [preset ?? cut(g["name"])];
  });
  const author = text(meta["author"]);
  return {
    vrm, title: text(meta["title"]) ?? "",
    authors: author ? [author] : [],
    license: { name: text(meta["licenseName"]), url: text(meta["otherLicenseUrl"]) },
    usage, expressions: unique(names),
  };
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.flatMap((s) => (typeof s === "string" ? [cut(s)] : [])) : [];
}
/** Expression names are sorted, de-duplicated and capped at 256 (DASH-MDL-013). */
const unique = (xs: string[]): string[] => [...new Set(xs)].sort().slice(0, EXPRESSIONS_MAX);

/** Opened without following a link and without blocking on a FIFO or device (DASH-MDL-002). */
export const READ_FLAGS = constants.O_RDONLY | NOFOLLOW | (constants.O_NONBLOCK ?? 0);
/** The bytes a head needs, read from a regular file one step at a time (never more than its declared JSON chunk). */
async function judgeFile(path: string, size: number): Promise<HeadVerdict> {
  const fh = await open(path, READ_FLAGS);
  try {
    if (!(await fh.stat()).isFile()) return { error: "the entry is not a regular file" };
    let buf = Buffer.alloc(0);
    for (;;) {
      const v = judgeHead(buf);
      if (!("need" in v)) return v;
      if (v.need > size) return { error: "the file ends inside its glTF head" };
      const next = Buffer.alloc(v.need - buf.length);
      const { bytesRead } = await fh.read(next, 0, next.length, buf.length);
      if (bytesRead < next.length) return { error: "the file ends inside its glTF head" };
      buf = Buffer.concat([buf, next]);
    }
  } finally {
    await fh.close();
  }
}

/** The stored-model folder: listing, the head checks and their cache, the temporary file of an upload, and the start-up sweep. */
export class ModelStore {
  private readonly cache = new Map<string, { size: number; mtimeMs: number; meta?: Meta; error?: string }>();

  constructor(
    readonly dir: string,
    /** Writes one chunk of an upload's body to its temporary file. Tests inject a failing one (DASH-MDL-029). */
    readonly writeChunk: (fh: FileHandle, chunk: Buffer) => Promise<void> = defaultWriteChunk,
    /** Awaited at the start of every listing: a test injects a delay here to widen a race. */
    private readonly pause: () => Promise<void> = async () => undefined,
  ) {}

  /** Removes every `.incoming-*` file left by an earlier run (DASH-MDL-031). Creates nothing. */
  // @spec DASH-MDL-031
  async sweep(): Promise<void> {
    for (const n of await this.names()) {
      if (n.startsWith(INCOMING)) await unlink(join(this.dir, n)).catch(() => undefined);
    }
  }

  /** The folder's entries that are regular files with a grammar name (DASH-MDL-002), sorted, with their head checks (DASH-MDL-011, DASH-MDL-014). */
  // @spec DASH-MDL-002, DASH-MDL-003, DASH-MDL-011, DASH-MDL-014
  async stored(): Promise<Stored[]> {
    await this.pause();
    const out: Stored[] = [];
    for (const name of await this.names()) {
      if (!modelNameOk(name)) continue;
      const path = join(this.dir, name);
      let st;
      try { st = await lstat(path, { bigint: true }); } catch { continue; }
      if (!st.isFile()) continue; // a symbolic link or a directory is never listed (DASH-MDL-002)
      const bytes = Number(st.size);
      const modified = Number(st.mtimeNs / 1_000_000n);
      const version = `${bytes.toString(16)}-${modified.toString(16)}`;
      let c = this.cache.get(name);
      if (!c || c.size !== bytes || c.mtimeMs !== modified) {
        // Only the error code leaves the store: a message can carry the folder's absolute path.
        const v = await judgeFile(path, bytes).catch((err: NodeJS.ErrnoException) => ({ error: `the file cannot be read (${err.code ?? "unknown error"})` }) as HeadVerdict);
        c = "ok" in v ? { size: bytes, mtimeMs: modified, meta: v.meta } : { size: bytes, mtimeMs: modified, error: "error" in v ? v.error : "the head is not readable" };
        this.cache.set(name, c);
      }
      out.push({ name, path, bytes, modified, version, ...(c.meta ? { meta: c.meta } : { error: c.error! }) });
    }
    return out.sort(byNameIC);
  }

  /** The stored models a selection may name: those listed without an error. */
  async loadable(): Promise<{ name: string; version: string }[]> {
    return (await this.stored()).filter((s) => s.error === undefined).map((s) => ({ name: s.name, version: s.version }));
  }

  /** Creates `.incoming-<16 hex>` exclusively in the folder, making the folder at the first upload (DASH-MDL-001, DASH-MDL-022). */
  // @spec DASH-MDL-001, DASH-MDL-022
  async createTemp(): Promise<{ fh: FileHandle; path: string }> {
    await mkdir(this.dir, { recursive: true });
    const path = join(this.dir, `${INCOMING}${randomBytes(8).toString("hex")}`);
    const fh = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o644);
    return { fh, path };
  }

  /** Links (without replace) or renames (with it) a finished temporary file to `dest` (DASH-MDL-028). */
  async commit(tmp: string, dest: string, replace: boolean): Promise<"ok" | "exists"> {
    if (replace) { await rename(tmp, dest); return "ok"; }
    try { await link(tmp, dest); } catch (err) { if ((err as NodeJS.ErrnoException).code === "EEXIST") return "exists"; throw err; }
    return "ok";
  }

  /** Names in the folder, empty when the folder does not exist yet. */
  async names(): Promise<string[]> {
    try { return await readdir(this.dir); } catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return []; throw err; }
  }
}

async function defaultWriteChunk(fh: FileHandle, chunk: Buffer): Promise<void> {
  let off = 0;
  while (off < chunk.length) {
    const { bytesWritten } = await fh.write(chunk, off, chunk.length - off);
    off += bytesWritten;
  }
}

/** A stored name's entry in the folder: its `Stored` record, found without regard to ASCII case. */
export const findStored = (list: readonly Stored[], name: string): Stored | undefined => list.find((s) => eqIC(s.name, name));
