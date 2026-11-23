import type { ChatSource, ChatSourceStatus } from "./source.js";

/** The YouTube source's placeholder until the live-chat reader lands (#179): a started YouTube source fails at once. */
export class YouTubeSource implements ChatSource {
  readonly name = "youtube" as const;

  state(): ChatSourceStatus {
    return { state: "starting" };
  }

  async start(): Promise<void> {
    throw new Error("the YouTube chat reader is not in this build yet");
  }

  stop(): void {}
}
