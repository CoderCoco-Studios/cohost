import type { Readable } from "node:stream";
import { createInterface, type Interface } from "node:readline";
import type { ChatSender } from "./filter.js";
import type { ChatSource, ChatSourceStartEnv, ChatSourceStatus } from "./source.js";

/** Scripted chat for `chat.sources` `fake`; a mix of mentions, questions and filtered lines. */
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
  cohostName: string;
  intervalMs: number;
  /** Lines typed or piped in. A TTY means "interactive": the script is not used at all. */
  stdin?: Readable & { isTTY?: boolean };
}

/** fake_viewer2 chats on youtube, the other fake viewers on twitch; every fake viewer's userId is its name. */
const fakeSender = (user: string): ChatSender => ({
  displayName: user,
  login: user,
  userId: user,
  isMod: false,
  isSub: false,
  ignoreIdentifiers: [user],
  platform: user === "fake_viewer2" ? "youtube" : "twitch",
});

// @spec CHAT-FAKE-001, CHAT-FAKE-002, CHAT-FAKE-004, CHAT-FAKE-005, CHAT-FAKE-007, CHAT-FAKE-008, CHAT-FAKE-009, CHAT-HEALTH-002
/**
 * Fake chat: stdin lines when stdin provides input, otherwise the script cycled every `intervalMs`. Reading from the
 * start; no platform library and no network. Its lines pass through the chat filter like any other source's.
 */
export class FakeSource implements ChatSource {
  readonly name = "fake" as const;
  private status: ChatSourceStatus = { state: "starting" };
  private timer?: ReturnType<typeof setInterval>;
  private rl?: Interface;

  constructor(private readonly opts: FakeSourceOptions) {}

  state(): ChatSourceStatus {
    return this.status;
  }

  async start(env: ChatSourceStartEnv): Promise<void> {
    const { stdin, cohostName, intervalMs } = this.opts;
    let stdinSeen = false;
    if (stdin) {
      this.rl = createInterface({ input: stdin });
      this.rl.on("line", (line) => { stdinSeen = true; env.emit(fakeSender("fake_viewer1"), line); });
    }
    this.status = { state: "reading" };
    env.onState("reading");
    if (stdin?.isTTY) return;

    const script = fakeScript(cohostName);
    let i = 0;
    this.timer = setInterval(() => {
      if (stdinSeen) return;
      const m = script[i++ % script.length]!;
      env.emit(fakeSender(m.user), m.text);
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.rl?.close();
    this.rl = undefined;
  }
}
