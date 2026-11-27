// Send one audio clip to cohost's ears `http` source. Node built-ins only.
//   CONTROL_TOKEN=<cohost's control token> mise run example:audio-send:ts -- <file> [--url <url>] [--speaker <name>] [--source <tag>]
// The listener key is derived from CONTROL_TOKEN, read from this command's environment only (export it from your password
// manager); the token itself is never sent.
// A copy outside the checkout runs as `node send-clip.ts <file> ...`.
// Runs with `node` on Node 22.18 or later, which strips the types.
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";

const DEFAULT_URL = "http://127.0.0.1:8765/audio";
const USAGE = "usage: node send-clip.ts <file> [--url <url>] [--speaker <name>] [--source <tag>]";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** Returns the file and the options; options may come before or after the file. */
function parse(argv: string[]): { file: string; options: Record<string, string> } {
  const options: Record<string, string> = { "--url": DEFAULT_URL };
  const files: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--url" || arg === "--speaker" || arg === "--source") {
      const value = argv[++i];
      if (value === undefined) fail(USAGE);
      options[arg] = value;
    } else if (arg.startsWith("--")) {
      fail(USAGE);
    } else {
      files.push(arg);
    }
  }
  if (files.length !== 1) fail(USAGE);
  return { file: files[0]!, options };
}

// #region send
/** The listener key: HMAC-SHA256 keyed with the trimmed control token of the label cohost/ears-listener/v1, as hex. */
function listenerKey(token: string): string {
  return createHmac("sha256", token.trim()).update("cohost/ears-listener/v1").digest("hex");
}

/** POST the file's bytes as audio/wav with the listener key. Returns the status and the reply body. */
async function send(file: string, url: string, key: string, speaker?: string, source?: string): Promise<{ status: number; text: string }> {
  const body = await readFile(file);
  const target = new URL(url);
  if (speaker) target.searchParams.set("speaker", speaker);
  if (source) target.searchParams.set("source", source);
  const headers: Record<string, string> = { "content-type": "audio/wav", authorization: `Bearer ${key}` };
  const reply = await fetch(target, { method: "POST", headers, body });
  return { status: reply.status, text: await reply.text() };
}
// #endregion send

const { file, options } = parse(process.argv.slice(2));
const token = (process.env.CONTROL_TOKEN ?? "").trim();
if (token === "") fail("send-clip.ts: set CONTROL_TOKEN to cohost's control token (from your password manager)");
try {
  const { status, text } = await send(file, options["--url"]!, listenerKey(token), options["--speaker"], options["--source"]);
  console.log(text);
  process.exit(status === 200 ? 0 : 1);
} catch (err) {
  fail(`send-clip.ts: ${err instanceof Error ? err.message : String(err)}`);
}
