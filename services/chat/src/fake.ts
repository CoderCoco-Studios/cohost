import type { Readable } from "node:stream";
import { createInterface } from "node:readline";
import type { EventInput } from "@cohost/bus";
import type { ChatUserInfo } from "./filter.js";

type ToEvent = (user: string, text: string, info: ChatUserInfo) => EventInput<"chat.message"> | undefined;

/** Scripted chat for `chat.source: fake`; a mix of mentions, questions and filtered lines. */
export function fakeScript(cohostName: string): { user: string; text: string }[] {
  return [
    { user: "fake_viewer1", text: `hey ${cohostName}, how's the stream going?` },
    { user: "fake_viewer2", text: "this game looks hard" },
    { user: "fake_viewer3", text: "!uptime" },
    { user: "fake_viewer1", text: `${cohostName} what's your favourite boss fight?` },
    { user: "fake_viewer2", text: "lol nice one" },
    { user: "fake_viewer3", text: `good evening ${cohostName}!` },
  ];
}

export interface FakeSourceOptions {
  toEvent: ToEvent;
  publish: (ev: EventInput<"chat.message">) => Promise<unknown> | unknown;
  cohostName: string;
  intervalMs: number;
  /** Lines typed or piped in. A TTY means "interactive": the script is not used at all. */
  stdin?: Readable & { isTTY?: boolean };
  /** Pipes are read too, but the script keeps running until the first line arrives. */
  onError?: (err: unknown) => void;
}

const info = (user: string): ChatUserInfo => ({ displayName: user, userId: user, isMod: false, isBroadcaster: false, isSubscriber: false });

/**
 * Fake chat: stdin lines when stdin provides input, otherwise the script cycled
 * every `intervalMs`. Everything passes through the normal chat filter.
 * Returns a stop function.
 */
export function startFakeSource(opts: FakeSourceOptions): () => void {
  const { toEvent, publish, intervalMs } = opts;
  const emit = (user: string, text: string) => {
    const ev = toEvent(user, text, info(user));
    if (ev) Promise.resolve(publish(ev)).catch((err) => opts.onError?.(err));
  };

  let stdinSeen = false;
  let rl: ReturnType<typeof createInterface> | undefined;
  if (opts.stdin) {
    rl = createInterface({ input: opts.stdin });
    rl.on("line", (line) => { stdinSeen = true; emit("fake_viewer1", line); });
  }
  if (opts.stdin?.isTTY) return () => rl?.close();

  const script = fakeScript(opts.cohostName);
  let i = 0;
  const timer = setInterval(() => {
    if (stdinSeen) return;
    const m = script[i++ % script.length]!;
    emit(m.user, m.text);
  }, intervalMs);
  return () => { clearInterval(timer); rl?.close(); };
}
