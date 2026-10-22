/** The pure half of reflect.ts: turning an LLM reply into a dated "## Learned" entry. */

const MARKER = "## Learned";

/** Keep only the "- " bullet lines of a reply (models like to add a preamble). */
export function parseBullets(raw: string): string[] {
  return raw.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("- "));
}

/** The block appended for one reflection. */
export function learnedBlock(bullets: string[], stamp: string): string {
  return `\n### ${stamp}\n${bullets.join("\n")}\n`;
}

/** Append the block to personality.md, adding the "## Learned" heading the first time. */
export function appendLearned(personality: string, addition: string): string {
  return personality.includes(MARKER)
    ? `${personality.trimEnd()}\n${addition}`
    : `${personality.trimEnd()}\n\n${MARKER}\n${addition}`;
}
