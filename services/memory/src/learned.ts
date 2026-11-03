/** The pure half of reflect.ts: turning an LLM reply into a dated "## Learned" entry. */

const MARKER = "## Learned";

// @spec MEM-REFLECT-005
/** Keep only the "- " bullet lines of a reply (models like to add a preamble). */
export function parseBullets(raw: string): string[] {
  return raw.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("- "));
}

/** The block appended for one reflection. */
export function learnedBlock(bullets: string[], stamp: string): string {
  return `\n### ${stamp}\n${bullets.join("\n")}\n`;
}

// @spec MEM-REFLECT-007
/** Put the block at the end of the "## Learned" section (before the next "## " heading), adding the heading at the end the first time. */
export function appendLearned(personality: string, addition: string): string {
  const heading = /^## Learned[ \t]*$/m.exec(personality);
  if (!heading) return `${personality.trimEnd()}\n\n${MARKER}\n${addition}`;
  const bodyStart = heading.index + heading[0].length;
  const next = /^## /m.exec(personality.slice(bodyStart));
  const end = next ? bodyStart + next.index : personality.length;
  const head = personality.slice(0, end).trimEnd();
  const tail = personality.slice(end);
  return `${head}\n${addition}${tail ? `\n${tail}` : ""}`;
}
