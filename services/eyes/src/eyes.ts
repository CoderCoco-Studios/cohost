import type { Publisher } from "@cohost/bus";
import { urls, type Config, type Logger } from "@cohost/config";

export interface EyesDeps {
  bus: Publisher;
  log: Logger;
  /** Base64 JPEG of the game source. */
  screenshot: () => Promise<string>;
  /** One line about the frame, or "SAME" / "" when nothing changed since `previous`. */
  describe: (b64: string, previous: string) => Promise<string>;
}

/** obs-websocket returns a data URL; the vision model wants bare base64. */
export function stripDataUrl(imageData: string): string {
  return imageData.replace(/^data:image\/\w+;base64,/, "");
}

/** Ask the Ollama vision model what changed. */
export function ollamaDescriber(cfg: Config["vision"]): EyesDeps["describe"] {
  return async (b64, previous) => {
    const res = await fetch(`${urls.ollama()}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: cfg.model,
        stream: false,
        keep_alive: "24h",
        options: { temperature: 0.2, num_predict: 60 },
        messages: [
          {
            role: "system",
            content:
              "You watch a live video game stream through a screenshot. Reply with ONE short sentence describing what is happening " +
              "that a co-host would care about: the game, the situation, anything dramatic, funny, or new (menus, deaths, wins, chat on screen). " +
              "No preamble. If nothing meaningful changed versus the previous description, reply exactly: SAME",
          },
          {
            role: "user",
            content: previous ? `Previous description: ${previous}\nWhat is happening now?` : "What is happening now?",
            images: [b64],
          },
        ],
      }),
    });
    if (!res.ok) throw new Error(`vision model ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { message?: { content?: string } };
    return (json.message?.content ?? "").trim().split("\n")[0] ?? "";
  };
}

/** One look at the screen; publishes `vision.summary` only when the model saw a change. */
export class Eyes {
  private previous = "";

  constructor(private d: EyesDeps) {}

  /** True when something new was published. */
  async look(): Promise<boolean> {
    const t0 = Date.now();
    const b64 = await this.d.screenshot();
    const text = await this.d.describe(b64, this.previous);
    const same = !text || /^same\b/i.test(text);
    if (same) {
      this.d.log.debug({ ms: Date.now() - t0 }, "no change");
      return false;
    }
    this.previous = text;
    await this.d.bus.publish("vision.summary", { text, changed: true });
    this.d.log.info({ ms: Date.now() - t0, text }, "saw");
    return true;
  }
}
