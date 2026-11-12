import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));

// @spec MOUTH-CONN-001, MOUTH-START-003
test("mouth holds no Discord client: no discord.js or @discordjs/voice import, no Discord token variable, no such dependency", () => {
  const src = join(root, "src");
  for (const f of readdirSync(src).filter((n) => n.endsWith(".ts"))) {
    const text = readFileSync(join(src, f), "utf8");
    assert.doesNotMatch(text, /discord\.js|@discordjs|discord-voice|EARS_DISCORD_TOKEN|DISCORD_TOKEN|joinVoiceChannel/, `${f} mentions a Discord client or token`);
  }
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { dependencies: Record<string, string> };
  for (const dep of ["discord.js", "@discordjs/voice", "@snazzah/davey", "libsodium-wrappers", "opusscript", "prism-media"]) {
    assert.equal(pkg.dependencies[dep], undefined, `${dep} is not an mouth dependency`);
  }
});
