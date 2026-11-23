import type { Logger } from "@cohost/config";
import type { ChatSender } from "./filter.js";

/** The sources `chat.sources` can list. */
export type ChatSourceName = "twitch" | "youtube" | "fake";

/** The platforms a `chat.message` can name. */
export type ChatPlatform = "twitch" | "youtube";

/** The one state vocabulary every source reports. */
export type ChatSourceState = "starting" | "waiting" | "reading" | "retrying" | "stopped";

export interface ChatSourceStatus {
  state: ChatSourceState;
  reason?: string;
}

/** A removal a source reports; the service publishes it as `chat.removed` with the source's platform. */
export interface ChatRemoval {
  scope: "message" | "user" | "all";
  messageId?: string;
  userId?: string;
  reason?: "banned" | "timeout" | "cleared";
}

/** What the chat service hands a source when it starts it. */
export interface ChatSourceStartEnv {
  emit(sender: ChatSender, text: string, messageId?: string): void;
  emitRemoval(removal: ChatRemoval): void;
  log: Logger;
  onState(state: ChatSourceState, reason?: string): void;
}

/** One chat source behind the common contract: started once, stopped once, reports its state through `onState`. */
export interface ChatSource {
  readonly name: ChatSourceName;
  state(): ChatSourceStatus;
  start(env: ChatSourceStartEnv): Promise<void>;
  stop(): void;
}
