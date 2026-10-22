import { urls, type Config } from "@cohost/config";

export interface ChatMessage { role: "system" | "user" | "assistant"; content: string }

/** Minimal Ollama client. Swap this file to point the brain at any OpenAI-compatible server. */
export class Ollama {
  constructor(private cfg: Config["llm"], private base = urls.ollama()) {}

  async chat(messages: ChatMessage[], opts: { maxTokens?: number; temperature?: number } = {}): Promise<string> {
    const res = await fetch(`${this.base}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.cfg.model,
        messages,
        stream: false,
        keep_alive: "24h",
        options: {
          temperature: opts.temperature ?? this.cfg.temperature,
          num_ctx: this.cfg.num_ctx,
          num_predict: opts.maxTokens ?? this.cfg.max_tokens,
          stop: ["\n\n", "\n[chat]", "\n[voice]", "\n[screen]"],
        },
      }),
    });
    if (!res.ok) throw new Error(`ollama chat ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { message?: { content?: string } };
    return (json.message?.content ?? "").trim();
  }

  async embed(text: string): Promise<number[]> {
    const res = await fetch(`${this.base}/api/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: this.cfg.embed_model, input: text, keep_alive: "24h" }),
    });
    if (!res.ok) throw new Error(`ollama embed ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as { embeddings?: number[][] };
    const v = json.embeddings?.[0];
    if (!v) throw new Error("ollama embed returned no vector");
    return v;
  }

  /** True once the model is loaded and answering. */
  async ping(): Promise<boolean> {
    try {
      const r = await fetch(`${this.base}/api/tags`);
      return r.ok;
    } catch {
      return false;
    }
  }
}
