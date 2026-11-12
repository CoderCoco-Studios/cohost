import type http from "node:http";

/** The cap on every JSON or text body the dashboard reads. */
export const BODY_LIMIT = 64 * 1024;

/** Thrown by `readText` when the body is over the cap (the rest has been drained and discarded). */
export class BodyTooLarge extends Error {}

/**
 * Collects a request body up to `max` bytes. Past the cap the rest is drained and discarded, `tooLarge` is true and
 * `data` is empty; a declared `content-length` over the cap is judged before any byte is kept.
 */
// @spec DASH-HTTP-015
export function readBody(req: http.IncomingMessage, max: number): Promise<{ data: Buffer; tooLarge: boolean }> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    let tooLarge = Number.isFinite(declared) && declared > max;
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      if (tooLarge) return;
      size += c.length;
      if (size > max) { tooLarge = true; chunks.length = 0; return; }
      chunks.push(c);
    });
    req.on("end", () => resolve({ data: tooLarge ? Buffer.alloc(0) : Buffer.concat(chunks), tooLarge }));
    req.on("error", reject);
  });
}

/** The request body as UTF-8 text, up to 64 KiB; past the cap `BodyTooLarge` is thrown. */
// @spec DASH-HTTP-015
export async function readText(req: http.IncomingMessage): Promise<string> {
  const { data, tooLarge } = await readBody(req, BODY_LIMIT);
  if (tooLarge) throw new BodyTooLarge();
  return data.toString("utf8");
}
