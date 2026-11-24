/**
 * What the built-in tools that wait on something outside the service share: the platform deadline, which ends a wait
 * before the call limit does (TOOL-STRM-005, TOOL-MEM-005), and the capped read of a response body (TOOL-STRM-008).
 */
import type { BuiltinSeams } from "./types.js";

/** Largest response body a built-in tool reads: 1 MiB, then the response is dropped as a failed platform. */
export const BODY_MAX_BYTES = 1024 * 1024;

/** Why a platform did not answer, for the sentence the service writes. */
export type Why = "unconfigured" | "refused" | "notfound" | "failed";

/** A platform call that failed; its `why` picks the sentence, and nothing of the platform's own text is kept. */
export class PlatformFailed extends Error {
  constructor(readonly why: Why) { super(why); }
}

/**
 * Runs one platform call with a deadline of `deadlineMs` on the injected scheduler. When the deadline passes, the call's
 * signal fires and the call fails as `failed`, even if the call itself never settles. The parent signal aborts the call too.
 */
// @spec TOOL-STRM-005
export function withDeadline<T>(
  schedule: BuiltinSeams["schedule"],
  deadlineMs: number,
  parent: AbortSignal,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const ctl = new AbortController();
  const onParentAbort = (): void => ctl.abort();
  if (parent.aborted) ctl.abort();
  else parent.addEventListener("abort", onParentAbort, { once: true });
  let cancel: () => void = () => {};
  const deadline = new Promise<never>((_, reject) => {
    cancel = schedule(() => {
      ctl.abort();
      reject(new PlatformFailed("failed"));
    }, deadlineMs);
  });
  return Promise.race([run(ctl.signal), deadline]).finally(() => {
    cancel();
    parent.removeEventListener("abort", onParentAbort);
  });
}

/** Reads a response body up to `BODY_MAX_BYTES`; a longer body is dropped and fails as `failed` (TOOL-STRM-008). */
// @spec TOOL-STRM-008
export async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (reader === undefined) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > BODY_MAX_BYTES) {
      await reader.cancel().catch(() => {});
      throw new PlatformFailed("failed");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { bytes.set(c, at); at += c.byteLength; }
  return new TextDecoder().decode(bytes);
}
