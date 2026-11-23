import { EMOTIONS, type Emotion } from "@cohost/config";

// The clause cutter for a streamed reply: a pure module fed the reply's text, with no bus and no timers (CTX-STREAM-004 to
// 011, 014, 015). The cortex decides what to publish; this module only finds where each clause ends.

/** Characters that end a clause when followed by whitespace (CTX-STREAM-008). */
const BOUNDARY = new Set([".", "!", "?", "…", ";", ":", ",", "。", "！", "？", "、", "，", "；", "："]);
/** Closing quotes that stay in the clause they close (CTX-STREAM-008). */
const CLOSERS = new Set(['"', "'", "”", "’", "»", ")"]);
/** The leading `[emotion]` and optional `[gesture:name]` of a reply (the same shape as parseReply). */
const TAG = /^\s*\[(\w+)\]\s*(?:\[gesture:([\w-]+)\]\s*)?/i;
/** An optional `Name:` before a tag (the same shape as parseReply). */
const NAME_BEFORE_TAG = /^[\w ]{1,20}:\s*(?=\[)/;
/** The tag hold ends with this many characters, whatever has been decided (CTX-STREAM-005, CTX-STREAM-006). */
export const TAG_HOLD_CHARS = 80;

/** The line's leading tags once they are decided, and the text the clauses are cut from. */
export interface Head {
  emotion: Emotion;
  gesture?: string;
  body: string;
}

function asEmotion(tag: string): Emotion {
  return EMOTIONS.find((e) => e === tag.toLowerCase()) ?? "neutral";
}

// @spec CTX-STREAM-005, CTX-STREAM-006, CTX-STREAM-007
/**
 * The leading tags of a reply read so far, or undefined while they are still incomplete. Decided when the text after an
 * optional `Name:` and tags begins with something that is not a tag, when a bracket that is not a tag closes, or when
 * `final` or the tag hold's length is reached. `raw` is the reply's first line so far.
 */
export function readHead(raw: string, final: boolean): Head | undefined {
  let s = raw.replace(/[«»]/g, "").replace(/^\s+/, "");
  const force = final || s.length >= TAG_HOLD_CHARS;
  if (!force && /^[\w ]{0,20}(:\s*)?$/.test(s)) return undefined; // could still become `Name:` followed by a tag
  const name = NAME_BEFORE_TAG.exec(s);
  if (name) s = s.slice(name[0].length);
  if (s.startsWith("[")) {
    const m = TAG.exec(s);
    if (m) {
      const rest = s.slice(m[0].length);
      if (!force && (rest === "" || (rest.startsWith("[") && !rest.includes("]")))) return undefined;
      return { emotion: asEmotion(m[1] ?? ""), ...(m[2] ? { gesture: m[2].toLowerCase() } : {}), body: rest };
    }
    if (!force && !s.includes("]")) return undefined;
    return { emotion: "neutral", body: s };
  }
  return { emotion: "neutral", body: s.replace(/^\w+:\s*/, "") };
}

/** Where a clause ends in the buffer: `end` is the clause's last index (exclusive), `next` where the rest begins. */
export interface Cut { end: number; next: number }

// @spec CTX-STREAM-008, CTX-STREAM-009, CTX-STREAM-010
/**
 * The first clause end in `buf`, or undefined when more text is needed to decide it (`final` false), or when the buffer
 * holds nothing to cut (`final` true returns the whole buffer). A boundary counts once the clause has `min` cleaned
 * characters; a clause reaching `max` is cut at its last whitespace, or before the bracket it would otherwise split.
 * Characters inside a bracketed span do not count toward the boundary or the length, except that an unclosed bracket's
 * characters count while it stays open, so a long open bracket still cuts (CTX-STREAM-010).
 */
export function cutClause(buf: string, min: number, max: number, final: boolean): Cut | undefined {
  let vis = 0;
  let lastWs = -1;
  let open = -1;
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i]!;
    if (c === "[" && open < 0) {
      const close = buf.indexOf("]", i + 1);
      if (close >= 0) { i = close; continue; } // a closed span is invisible
      if (!final) open = i; // an unclosed bracket is text only once the reply has ended
    }
    if (open >= 0) {
      vis++;
      if (vis > max) {
        if (lastWs > 0) return { end: lastWs, next: lastWs };
        return open > 0 ? { end: open, next: open } : undefined; // wait for the bracket to close
      }
      continue;
    }
    if (/\s/.test(c) && vis <= max) lastWs = i;
    vis++;
    if (BOUNDARY.has(c) && vis >= min && vis <= max) {
      let j = i + 1;
      while (j < buf.length && CLOSERS.has(buf[j]!)) j++;
      if (j >= buf.length) return final ? { end: j, next: j } : undefined;
      if (/\s/.test(buf[j]!)) return { end: j, next: j };
    }
    if (vis > max) {
      if (lastWs > 0) return { end: lastWs, next: lastWs };
      return { end: i, next: i };
    }
  }
  return final ? { end: buf.length, next: buf.length } : undefined;
}

// @spec CTX-STREAM-014, CTX-STREAM-015
/** A clause as it is spoken: bracketed spans, `«` and `»` and surrounding quotes removed, whitespace collapsed. */
export function cleanClause(raw: string): string {
  return raw
    .replace(/\[[^\]]*\]/g, "")
    .replace(/[«»]/g, "")
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Whether a cleaned clause has a word character; one that has none is not published (CTX-STREAM-015). */
export function hasWord(text: string): boolean {
  return /[\p{L}\p{M}\p{N}]/u.test(text);
}
