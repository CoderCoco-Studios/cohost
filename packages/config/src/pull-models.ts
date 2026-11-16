/**
 * Entry point of the compose `models` service: loads the config (an invalid `config.yaml` stops here with the loader's message
 * naming the keys, and nothing is pulled), waits for Ollama, then pulls `ollamaModels` one after another, the required names
 * first. A pull fails on a request error, an HTTP error or an `"error"` line in the response (Ollama reports an error that begins
 * after the response started as a 200 holding such a line). Every model is tried; the exit status is non-zero only when a
 * required pull failed, a failed optional pull being a warning (its hook falls back to rules).
 */
// @spec CFG-MODEL-002
import { loadConfig, ollamaModels, urls } from "./index.js";

const out = (s: string): void => { process.stdout.write(`${s}\n`); };
const err = (s: string): void => { process.stderr.write(`${s}\n`); };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** The last 200 bytes of a response, as the compose script printed them. */
const tail = (text: string): string => Buffer.from(text).subarray(-200).toString("utf8").trim();

async function waitForOllama(base: string): Promise<void> {
  for (;;) {
    try {
      const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) return;
    } catch { /* not up yet */ }
    await sleep(2000);
  }
}

/** Pulls one model; returns the failure text, or undefined on success. */
async function pull(base: string, model: string): Promise<string | undefined> {
  out(`pulling ${model}`);
  let body = "";
  try {
    // `name` is the older field, `model` the current one; Ollama reads whichever it knows.
    const res = await fetch(`${base}/api/pull`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, name: model }) });
    body = await res.text();
    if (!res.ok) return `HTTP ${res.status}: ${tail(body)}`;
  } catch (e) {
    return (e as Error).message;
  }
  if (/"error"/.test(body)) return tail(body);
  out(tail(body));
  return undefined;
}

async function main(): Promise<number> {
  let models: ReturnType<typeof ollamaModels>;
  try {
    models = ollamaModels(loadConfig());
  } catch (e) {
    err((e as Error).message);
    return 1;
  }
  const base = urls.ollama();
  if (models.required.length + models.optional.length === 0) { out("no Ollama models to pull"); return 0; }
  await waitForOllama(base);
  let failed = false;
  for (const model of models.required) {
    const problem = await pull(base, model);
    if (problem !== undefined) { err(`pull FAILED: ${model}: ${problem}`); failed = true; }
  }
  for (const model of models.optional) {
    const problem = await pull(base, model);
    if (problem !== undefined) err(`WARNING: optional model ${model} not pulled (${problem}); the hook that uses it falls back to rules`);
  }
  return failed ? 1 : 0;
}

process.exitCode = await main();
