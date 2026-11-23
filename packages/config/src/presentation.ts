/**
 * The presentation table: everything the Settings screen needs to name and explain a setting, beside the zod schema it
 * describes. Data only: it holds no value and no default. A test (`presentation.test.ts`) fails when a section or key of
 * the schema has no entry here, or an entry here names something the schema does not have, so a new setting cannot ship
 * unexplained. `sectionPresentation` (editor.ts) joins this table to what `GET /config/schema` serves, and `sectionJsonSchema`
 * uses each key's `help` as its JSON Schema `description`, so help has this one source.
 *
 * Writing help: one or two plain sentences an operator who is not a programmer can act on: what the setting changes in what
 * the co-host does, and what a higher or lower, on or off value means. Read the code that consumes the key before writing it.
 */
// @spec CFG-PRES-001, CFG-PRES-012, CFG-PRES-013, CFG-PRES-002, CFG-PRES-003, CFG-PRES-004, CFG-PRES-005, CFG-PRES-006, CFG-PRES-009, CFG-PRES-010, CFG-PRES-011, CFG-SCH-026

/** The sidebar groups of the Settings screen, in order. */
export const GROUPS = ["Identity", "Brain", "Senses", "Voice and body", "System"] as const;
export type Group = (typeof GROUPS)[number];

export type ModelKind = "chat" | "small" | "vision" | "embed" | "stt";

/** A control hint from a closed set; the page treats any other as absent. */
export type Widget =
  | { type: "timezone" }
  | { type: "voice" }
  | { type: "sources" }
  | { type: "textarea" }
  | { type: "model"; kind: ModelKind }
  | { type: "options"; options: { value: string; label: string }[] };

/** One property of an array-of-objects key's item. */
export interface ItemPresentation { help: string; label?: string; unit?: string }

export interface KeyPresentation {
  /** One or two plain sentences: what the setting changes and what a higher or lower, on or off value means. */
  help: string;
  /** Display name when the key name is not plain. */
  label?: string;
  /** `ms`, `bytes`, `days` and the like. */
  unit?: string;
  widget?: Widget;
  /** Only on an array of objects: the help of each property of an item. */
  items?: Record<string, ItemPresentation>;
  /** The key decides where a secret-bearing or private request goes, so changing it needs the control token. */
  sensitive?: true;
}

export interface SectionPresentation {
  title: string;
  group: Group;
  about: string;
  /** Another section whose screen shows this one. */
  page?: string;
}

/** The declared sections, in screen order: each top-level key of `ConfigSchema` except `brain`, plus the seven brain parts. */
export const SECTION_PATHS: readonly string[] = [
  "cohost", "llm", "brain.salience", "brain.working_memory_events", "brain.working_memory_own_lines", "brain.affect", "brain.memory", "brain.cortex",
  "brain.input_limits", "viewer_text",
  "chat", "vision", "ears", "voice", "mouth", "avatar", "connections", "dashboard",
];

const sections: Record<string, SectionPresentation> = {
  "cohost": { title: "Identity", group: "Identity", about: "The co-host's name, your name and the time zone it is told the time in, all of which go into every reply it writes and decide when chat counts as talking to it." },
  "llm": { title: "Language model", group: "Brain", about: "Which model writes the co-host's replies, how long and how adventurous they are, and the accounts a hosted model needs." },
  "brain.salience": { title: "Salience", group: "Brain", about: "Salience decides when the co-host speaks up: how much a chat line, remark or screen change has to matter, how long it waits between lines, when it chats unprompted, and its instant canned reflexes." },
  "brain.working_memory_events": { title: "Working memory", group: "Brain", about: "How many recent events (chat lines, remarks, screen changes, its own lines) the co-host keeps in view when it decides to speak and when it writes a reply.", page: "brain.memory" },
  "brain.working_memory_own_lines": { title: "Own lines kept", group: "Brain", about: "How many of the co-host's own recent lines are never dropped from what it keeps in view, so a flood of chat cannot push them out and leave it repeating itself.", page: "brain.memory" },
  "brain.affect": { title: "Mood", group: "Brain", about: "The co-host's mood: what pushes it up or down, how quickly it settles back, and how it shows in the replies, in when the co-host speaks and on the avatar." },
  "brain.memory": { title: "Memory", group: "Brain", about: "What the co-host remembers: how many past moments it recalls for each reply, how it tells regulars from newcomers, and how its short notes about each viewer are kept, fade and are tidied." },
  "brain.cortex": { title: "Replies", group: "Brain", about: "How a reply is produced: how long the co-host waits for memory and for the voice, how it reacts to a line that failed to play, and the optional editor that checks a reply before it is spoken." },
  "brain.input_limits": { title: "Text limits", group: "Brain", about: "How long a spoken transcript or a screen description may be before it reaches a prompt; anything longer is cut short." },
  "viewer_text": { title: "Viewer text", group: "Brain", about: "How long a chat message and a viewer's name may be before they reach a prompt; anything longer is cut short." },
  "chat": { title: "Chat", group: "Senses", about: "Which chat sources the co-host reads (Twitch, YouTube, fake), the Twitch channel and account, the YouTube video, and which users and commands it ignores." },
  "vision": { title: "Vision", group: "Senses", about: "Whether the co-host looks at your game through OBS, which model describes the screen, how often, and how the description is worded." },
  "ears": { title: "Hearing", group: "Senses", about: "Where the co-host's audio comes from and how it is cut into sentences and turned into text." },
  "voice": { title: "Voice", group: "Voice and body", about: "The co-host's speaking voice, pace and text clean-up, and the lines it says aloud when speech fails." },
  "mouth": { title: "Speech output", group: "Voice and body", about: "Where the co-host's spoken audio is sent (the Discord voice channel, a folder, a web address), how loud it is, and how often a fallback line may play." },
  "avatar": { title: "Avatar", group: "Voice and body", about: "Which avatar app the co-host drives (VTube Studio or a VMC receiver) and how smoothly and lively it moves." },
  "connections": { title: "Discord", group: "System", about: "The Discord bot's server, voice channel and token, shared by hearing and speaking." },
  "dashboard": { title: "Dashboard", group: "System", about: "The dashboard's web ports, the machine names it accepts, and the size and lifetime limits of its test uploads." },
};

/** The five keys of a region hook (`ModuleSchema`), under `base` (a dotted path), with help written for what that hook decides. */
function hook(base: string, p: { kind: string; url: string; timeout: string; unit?: string; modelKind: ModelKind; what: string }): Record<string, KeyPresentation> {
  return {
    [`${base}.kind`]: { help: p.kind },
    [`${base}.url`]: { help: p.url, sensitive: true, label: "URL" },
    [`${base}.timeout_ms`]: { help: p.timeout, unit: "ms" },
    [`${base}.llm.provider`]: { help: `Only for kind "llm": run ${p.what} on this provider instead of the main one, for example a small local Ollama model while the co-host talks through something bigger. Leave empty to use the main provider; a model name is then required.`, label: "Provider override" },
    [`${base}.llm.model`]: { help: `Only for kind "llm": the model that does ${p.what}, named as its provider spells it. Leave empty to use the main model (llm.model); it must be set whenever a provider override is.`, label: "Model override", widget: { type: "model", kind: p.modelKind } },
  };
}

const lang = (value: string, label: string) => ({ value, label });

const keys: Record<string, KeyPresentation> = {
  // ---- cohost
  "cohost.name": { help: "What the co-host calls itself. A chat line that contains this name (any capitals) counts as talking to the co-host, which makes it much more likely to answer.", label: "Co-host name" },
  "cohost.streamer": { help: "Your name, as the co-host should know and say it; it is put into every prompt so the co-host knows who it is co-hosting for.", label: "Your name" },
  "cohost.timezone": { help: "The time zone the co-host is told the current date and time in, so what it says about the time or time of day matches yours.", widget: { type: "timezone" }, label: "Time zone" },

  // ---- llm
  "llm.provider": { help: "Who writes the co-host's replies: ollama is a model on your own graphics card, openai is any OpenAI-compatible service, anthropic is Claude through the Claude API, bedrock is Claude through Amazon Bedrock, and mock gives canned offline replies for testing only. Memory search always uses local Ollama whatever you pick here." },
  "llm.model": { help: "The model that writes the replies, named exactly as the chosen provider spells it (an Ollama tag like qwen2.5:7b, an OpenAI-style id, or a Claude id). A bigger model usually writes better lines but answers more slowly, which shows as a longer pause before the co-host speaks.", widget: { type: "model", kind: "chat" } },
  "llm.num_ctx": { help: "Ollama only: how much text, counted in tokens (a token is about three quarters of a word), the model can hold in mind at once, your prompt and its reply together. Higher lets it keep more chat history in view but uses more graphics memory; too low makes it forget the start of the conversation.", unit: "tokens", label: "Context window" },
  "llm.temperature": { help: "Ollama and OpenAI-compatible only: how adventurous the replies are, from 0 to 2. Lower is steadier and repeats itself more; higher is livelier and funnier but more likely to ramble or go off topic. Claude models do not use it." },
  "llm.max_tokens": { help: "Ollama and OpenAI-compatible only: the longest reply the model may write, in tokens (about three quarters of a word each). Keep it short because the replies are spoken aloud; a higher limit lets the co-host talk for longer. Claude uses its own limit under claude.", unit: "tokens", label: "Reply length limit" },
  "llm.embed_model": { help: "The Ollama model that turns text into numbers so memory can find similar past moments. It always runs on local Ollama, whatever the provider. Memories saved with the old model have to be re-embedded after you change it.", widget: { type: "model", kind: "embed" }, label: "Memory search model" },
  "llm.timeout_ms": { help: "How long to wait for the model to answer a request before giving up on it. Lower gives up on a stuck model sooner; higher waits longer for a slow model or a slow first load.", unit: "ms" },
  "llm.openai.base_url": { help: "Only for provider openai: the web address of the OpenAI-compatible service, for example OpenAI itself, OpenRouter, Groq or a model server you run. The API key is sent to this address, so only point it somewhere you trust.", sensitive: true, label: "Base URL" },
  "llm.openai.api_key": { help: "Only for provider openai: the API key of the service named above. It is stored in secrets.yaml and is never shown again once saved." },
  "llm.claude.api_key": { help: "Only for provider anthropic: your Claude API key from the Claude console. It is stored in secrets.yaml and is never shown again once saved." },
  "llm.claude.effort": { help: "Provider anthropic or bedrock: how hard Claude thinks before answering. Low is right for one-line chat replies and answers fastest; higher can give better lines but is slower and uses more of the token limit.", label: "Thinking effort" },
  "llm.claude.max_tokens": { help: "Provider anthropic or bedrock: the most Claude may write in total, its thinking and the reply together, counted in tokens. Keep it roomier than a normal reply so thinking never cuts the reply short.", unit: "tokens" },
  "llm.claude.fallbacks": { help: "Provider anthropic only: when on, a request that Claude's safety check declines is retried on another Claude model so the co-host still answers. Off, a declined request is not retried.", label: "Retry on another Claude model" },
  "llm.bedrock.region": { help: "Only for provider bedrock: the AWS region of the Bedrock service, such as us-east-1. It is used together with the access key id and secret access key below, and all three are needed.", label: "AWS region" },
  "llm.bedrock.access_key_id": { help: "Only for provider bedrock: the AWS access key id of an IAM user allowed to use Bedrock. It is stored in secrets.yaml and is never shown again once saved.", label: "AWS access key id" },
  "llm.bedrock.secret_access_key": { help: "Only for provider bedrock: the secret access key that goes with the access key id. It is stored in secrets.yaml and is never shown again once saved.", label: "AWS secret access key" },

  // ---- vision
  "vision.enabled": { help: "Turns the co-host's eyes on. Off, the vision service stays idle and never touches OBS, so the co-host reacts to chat and speech only; on, it keeps an eye on your game and can comment on what happens." },
  "vision.model": { help: "The Ollama vision model that describes the screenshot. Required while vision is on; a larger model describes better but takes longer on each look.", widget: { type: "model", kind: "vision" } },
  "vision.engine": { help: "ollama asks the vision model to describe each screenshot; stub replies with fixed text and calls no model, for testing the rest of the stack without a graphics card." },
  "vision.prompt": { help: "The instruction the vision model follows for each screenshot, which decides how the screen is described. Keep the rule to reply exactly SAME when nothing meaningful changed, or every look counts as a change and the co-host keeps reacting.", widget: { type: "textarea" } },
  "vision.temperature": { help: "How adventurous the screen descriptions are, from 0 to 2. Keep it low so the description stays factual; higher makes it more inventive and less reliable." },
  "vision.num_predict": { help: "The longest description the vision model may write, in tokens (about three quarters of a word each). Lower keeps descriptions to a short sentence; higher lets it say more but slows each look.", unit: "tokens", label: "Description length limit" },
  "vision.jpeg_quality": { help: "How sharp the screenshot sent to the vision model is, from 1 to 100. Higher is clearer but a bigger picture to send and read; lower is faster and may blur small text.", label: "Screenshot quality" },
  "vision.interval_ms": { help: "How often the co-host looks at your game. Lower reacts to changes sooner but keeps the vision model busy; higher is lighter on your graphics card but slower to notice things.", unit: "ms", label: "Look every" },
  "vision.timeout_ms": { help: "How long to wait for the vision model to describe one screenshot before giving up on that look. Raise it if a slow model keeps timing out.", unit: "ms" },
  "vision.upload_timeout_ms": { help: "For images you send from the dashboard's test panel: how long to wait while fetching the uploaded picture before giving up.", unit: "ms" },
  "vision.upload_max_bytes": { help: "For images you send from the dashboard's test panel: the largest picture the vision service will accept. A bigger upload is refused.", unit: "bytes" },
  "vision.obs.host": { help: "The computer OBS runs on. From Docker on the same machine use host.docker.internal; for OBS on a second PC use its address on your network. The OBS password is sent to this address, so only point it somewhere you trust.", sensitive: true, label: "OBS host" },
  "vision.obs.port": { help: "The port of OBS's WebSocket server, shown in OBS under Tools, WebSocket Server Settings. The OBS password is sent to this port, so only point it somewhere you trust.", sensitive: true, label: "OBS port" },
  "vision.obs.password": { help: "The password of OBS's WebSocket server. Leave it empty if the server needs none. It is stored in secrets.yaml and is never shown again once saved.", label: "OBS password" },
  "vision.obs.source": { help: "The name of the OBS scene or source to take screenshots of, exactly as it appears in OBS.", label: "OBS source" },
  "vision.obs.width": { help: "The width, in pixels, the screenshot is shrunk to before the vision model sees it. Smaller is faster; larger keeps more detail but slows each look.", unit: "px", label: "Screenshot width" },

  // ---- chat
  // @spec CFG-PRES-006
  "chat.sources": { help: "Where the co-host reads chat from: twitch (a Twitch channel), youtube (a YouTube live chat) and fake (scripted messages with no channel, handy for trying the co-host out). Every source listed is read at once; empty turns chat off.", label: "Chat sources", widget: { type: "sources" } },
  "chat.youtube.video": { help: "The YouTube video or live stream whose chat the co-host reads: a video id, a link, or a channel handle. Leave empty when YouTube is not in the sources.", label: "YouTube video" },
  "chat.youtube.api_key": { help: "The YouTube Data API key the co-host reads the live chat with. It is stored in secrets.yaml and is never shown again once saved." },
  "chat.youtube.transport": { help: "How the YouTube chat is read: stream keeps a live connection open, poll asks for new messages on a timer (use it when streaming stays unreliable). Blank means stream.", label: "YouTube transport" },
  "chat.youtube.poll_floor_ms": { help: "Only for transport poll: the shortest gap between two chat polls. Lower reads newer messages sooner but uses more of the API quota.", label: "Poll floor", unit: "ms" },
  "chat.youtube.recheck_ms": { help: "How often the video is checked again for a live chat when none was found. Lower notices a new stream sooner but uses more of the API quota.", label: "Recheck interval", unit: "ms" },
  "chat.fake.interval_ms": { help: "Only for source fake: how long between one scripted message and the next. Lower makes a busier fake chat.", unit: "ms" },
  "chat.twitch.channel": { help: "The Twitch channel whose chat the co-host reads, with or without the # sign.", label: "Twitch channel" },
  "chat.twitch.client_id": { help: "The client id of the Twitch application you registered for the co-host's account. It is stored in secrets.yaml and is never shown again once saved." },
  "chat.twitch.client_secret": { help: "The client secret of the Twitch application. It is stored in secrets.yaml and is never shown again once saved." },
  "chat.twitch.access_token": { help: "A user access token for the Twitch account the co-host reads chat as. It is stored in secrets.yaml and is never shown again once saved." },
  "chat.twitch.refresh_token": { help: "The refresh token that goes with the access token; it is required whenever an access token is set, because it lets the co-host renew an expired one. It is stored in secrets.yaml and is never shown again once saved." },
  "chat.ignore_users": { help: "Chat users the co-host never reads, such as your bots, (capitals do not matter). Their messages never reach the co-host's brain at all.", label: "Ignored users" },
  "chat.ignore_prefixes": { help: "Chat lines that start with any of these are ignored, which keeps bot commands such as !uptime from being treated as conversation.", label: "Ignored line starts" },

  // ---- brain.working_memory_events
  "brain.working_memory_events": { help: "How many of the most recent events (chat lines, things said aloud, screen changes and the co-host's own lines) salience and the reply writer each keep in view. Higher gives replies more context about the last few minutes but makes every prompt longer and slower; lower makes the co-host forget sooner.", label: "Events kept in view" },

  // ---- brain.working_memory_own_lines
  "brain.working_memory_own_lines": { help: "How many of the co-host's own most recent lines always stay in view, however much chat arrives after them. Higher helps it remember what it just said in a busy chat but leaves less room for everything else; it must be lower than the number of events kept in view.", label: "Own lines kept in view" },

  // ---- brain.input_limits
  "brain.input_limits.speech_max_chars": { help: "The longest spoken transcript the co-host takes in; a longer one is cut to this length and marked as cut. Lower keeps prompts short and quick; higher lets a long remark through whole. It cannot be below 16.", unit: "chars", label: "Longest spoken transcript" },
  "brain.input_limits.vision_max_chars": { help: "The longest screen description the co-host takes in; a longer one is cut to this length and marked as cut. Lower keeps prompts short and quick; higher keeps more detail about the screen. It cannot be below 16.", unit: "chars", label: "Longest screen description" },

  // ---- viewer_text
  "viewer_text.max_chars": { help: "The longest chat message the co-host takes in; a longer one is cut to this length and marked as cut. The default is Twitch's own message limit; lower keeps a wall of text from filling the prompt. It cannot be below 16.", unit: "chars", label: "Longest chat message" },
  "viewer_text.max_name_chars": { help: "The longest viewer name the co-host takes in or shows; a longer one is cut to this length and marked as cut. Lower keeps an overlong name from crowding the prompt. It cannot be below 8.", unit: "chars", label: "Longest viewer name" },

  // ---- brain.salience
  "brain.salience.tick_ms": { help: "How often salience re-checks whether it is time to speak. Chat, screen changes and quiet-time chatter are only noticed at these checks, so a lower number reacts to chat sooner; speech is handled at once unless trigger_on_speech is off.", unit: "ms", label: "Check every" },
  "brain.salience.trigger_on_speech": { help: "When on, a finished sentence you say aloud is considered immediately instead of waiting for the next check, so the co-host answers you faster. Off makes it wait for the next check, which adds up to one check interval of delay." },
  "brain.salience.barge_in": { help: "When on, if someone speaks over the co-host while it is talking, it stops talking and can answer them. Off, it always finishes its line. It is off by default because it has only been tested with Discord voice." },
  "brain.salience.barge_in_sources": { help: "Which audio sources are allowed to interrupt the co-host: discord, http, dir, or the name of another connector. Speech from a source not in this list never interrupts.", widget: { type: "sources" } },
  "brain.salience.barge_in_min_words": { help: "How many words an interruption needs before it stops the co-host. Raise it so a short \"mm-hm\" or cough does not cut the co-host off; lower it to stop on any word.", unit: "words" },
  "brain.salience.cooldown_ms": { help: "The shortest pause after the co-host speaks before it may decide to speak again. Higher makes it quieter and gives viewers room to talk; lower lets it reply in quick succession.", unit: "ms" },
  "brain.salience.thinking_timeout_ms": { help: "If the co-host has been working on a reply this long without finishing, salience stops waiting for it and may start over. It is a safety net for a stuck model; raise it only if your model is very slow.", unit: "ms" },
  "brain.salience.idle_chatter_ms": { help: "If nothing has happened for this long and there is something new it has not yet commented on, the co-host speaks up unprompted. Lower makes it chattier in quiet moments; 0 turns idle chatter off.", unit: "ms", label: "Idle chatter after" },
  "brain.salience.reply_on_mention": { help: "When on, a chat line that contains the co-host's name always gets an answer (it scores the maximum). Off, a mention counts like any other chat line and may be passed over." },
  "brain.salience.speak_threshold": { help: "How much recent activity it takes for the co-host to speak. Each new event is scored (with the built-in scoring: you speaking about 0.9, a question in chat about 0.55, plain chat about 0.15) and the scores add up until they reach this number. Higher makes the co-host quieter, lower makes it speak up more readily; a mention of its name always answers when reply_on_mention is on.", label: "Speak threshold" },
  "brain.salience.arousal_bias": { help: "How much an excited mood lowers the speak threshold, from 0 to 1. At 0 the mood has no effect on how often the co-host speaks; higher makes a lively co-host noticeably chattier." },
  ...hook("brain.salience.module", {
    kind: "How events are scored for salience: rules uses the built-in scores, llm asks a language model, http sends them to a server you run. If the chosen judge fails, the built-in rules score the events instead.",
    url: "Only for kind http: the address of your own server that scores events. Each request carries the recent chat and speech text, so only point it somewhere you trust.",
    timeout: "How long to wait for the model or your server to score events before giving up and using the built-in scores.",
    modelKind: "small", what: "the event scoring",
  }),
  "brain.salience.reflexes": {
    help: "Instant canned reactions that skip the language model: when an event matches a pattern, the co-host says one of your lines at once. Each reflex has its own cooldown, and a reflex never talks over the co-host or breaks the pause after its last line.",
    items: {
      match: { help: "A pattern, case-insensitive, tested against the text of each chat line, spoken sentence or screen description; the reflex fires when it matches anywhere in it. Plain words work, and you can use a regular expression for more." },
      on: { help: "Which senses this reflex listens to: chat, speech (what is said aloud) or vision (screen descriptions). All three are listened to unless you narrow it.", label: "Listens to" },
      say: { help: "What the co-host says when the reflex fires; with several lines, one is picked at random each time.", label: "Lines to say" },
      emotion: { help: "The emotion shown on the avatar and in the voice while this line is said.", label: "Emotion" },
      gesture: { help: "An optional avatar gesture to play with the line, using a gesture name from your avatar's expression map. Leave empty for none." },
      cooldown_ms: { help: "How long after firing this reflex stays quiet, so a spammed word cannot make the co-host repeat itself. Higher means it reacts less often.", unit: "ms", label: "Cooldown" },
    },
  },

  // ---- brain.affect
  "brain.affect.publish_ms": { help: "How often the mood is announced to the rest of the co-host (avatar, replies, salience) while it is changing. Lower makes the avatar's mood track more smoothly at the cost of more messages.", unit: "ms" },
  "brain.affect.half_life_ms": { help: "How long a mood swing takes to fade halfway back to the resting mood. Higher keeps the co-host excited or down for longer; lower makes it bounce back to normal quickly.", unit: "ms", label: "Settle time" },
  "brain.affect.baseline_valence": { help: "The co-host's resting mood on a scale from -1 (gloomy) to 1 (delighted), where it settles when nothing is happening. A sunny co-host sits a little above 0.", label: "Resting mood" },
  "brain.affect.baseline_arousal": { help: "The co-host's resting energy, from 0 (sleepy) to 1 (wired), where it settles when nothing is happening. Higher makes it more animated by default and, through the speak threshold, a little chattier.", label: "Resting energy" },
  "brain.affect.republish_ms": { help: "An unchanged mood is announced again this often, so a part of the co-host that starts late still learns the current mood. It does not change the mood itself.", unit: "ms" },
  "brain.affect.short_line_chars": { help: "Only when the mood is judged by a model or server: a chat or spoken line shorter than this (and not mentioning the co-host) is judged by the built-in rules instead, since there is too little tone to be worth a model call.", unit: "chars" },
  "brain.affect.count_window_ms": { help: "After a viewer, or a particular text, has moved the mood, the same viewer and the same text do not move it again for this long. Higher makes it harder for one person or a pasted line to swing the mood; lower lets repeated lines count sooner.", unit: "ms", label: "Count a viewer or text once per" },
  "brain.affect.nudge_sub_valence": { help: "How much a chat line from a subscriber lifts the mood, from 0 to 1. Higher makes subs cheer the co-host up more; 0 means subs do not change its mood.", label: "Subscriber boost to mood" },
  "brain.affect.nudge_sub_arousal": { help: "How much a chat line from a subscriber raises the co-host's energy, from 0 to 1. Higher makes subscribers wind it up more.", label: "Subscriber boost to energy" },
  "brain.affect.nudge_screen_arousal": { help: "How much a change on screen raises the co-host's energy, from 0 to 1. Higher makes a busy game keep it more worked up.", label: "Screen change boost to energy" },
  "brain.affect.nudge_said_valence": { help: "How much the co-host's own happy, laughing or smug line lifts its mood (and a sad or angry line lowers it), from 0 to 1. Higher makes it feed on its own tone.", label: "Own line effect on mood" },
  "brain.affect.nudge_said_arousal": { help: "How much any line the co-host says raises its energy, from 0 to 1. Higher makes talking itself wind the co-host up.", label: "Own line boost to energy" },
  ...hook("brain.affect.module", {
    kind: "How a line of chat or speech moves the mood: rules uses the built-in judgement, llm asks a language model, http sends it to a server you run. If the chosen judge fails, the built-in rules judge it instead.",
    url: "Only for kind http: the address of your own server that judges how a line should move the mood. Each request carries the line's text, so only point it somewhere you trust.",
    timeout: "How long to wait for the model or your server to judge a line before giving up and using the built-in rules.",
    modelKind: "small", what: "the mood judging",
  }),

  // ---- brain.memory
  "brain.memory.store": { help: "postgres keeps memories in the database so they last between sessions; memory keeps them only in the running service and loses them at shutdown, for development and testing." },
  "brain.memory.embedder": { help: "ollama turns text into numbers with your embedding model so memory can find similar moments; hash is a simple offline stand-in that never contacts Ollama and matches only texts that share the same words, with no sense of meaning, for testing." },
  "brain.memory.recall_k": { help: "How many past memories are looked up and shown to the co-host for each reply. Higher gives it more to draw on but lengthens the prompt; 0 turns memory recall off.", label: "Memories recalled per reply" },
  "brain.memory.min_similarity": { help: "How closely a past memory must match what is being talked about before it is recalled, from 0 (anything) to 1 (identical). Higher recalls fewer but more relevant memories; lower recalls more, including loose matches." },
  "brain.memory.regular_messages": { help: "How many messages a viewer must have sent over time before the co-host treats them as a regular rather than a newcomer. You can also mark a viewer as a regular by hand.", label: "Messages to count as a regular" },
  "brain.memory.notes.dirty_threshold": { help: "How many new or changed viewer notes pile up before a tidy-up pass starts. Lower tidies sooner but runs the model more often; the pass also runs once after you shut the co-host down.", label: "Notes before a tidy-up" },
  "brain.memory.notes.recent_half_life_days": { help: "How long a recent note about a viewer takes to lose half its strength if the viewer does not come up again. Lower makes the co-host forget new details faster.", unit: "days" },
  "brain.memory.notes.core_half_life_days": { help: "How long a lasting (core) note takes to lose half its strength. Higher keeps long-term facts about a viewer around for longer.", unit: "days" },
  "brain.memory.notes.reinforce": { help: "How much a repeated mention strengthens a note, from 0 to 1: the share of the gap to full strength it closes. Higher makes a note jump back to full strength after one repeat; lower makes it build up slowly.", label: "Strengthen on repeat" },
  "brain.memory.notes.promote_mentions": { help: "How many times a recent note must come up before it becomes a lasting (core) note that fades more slowly. Lower makes details stick sooner." },
  "brain.memory.notes.demote_below": { help: "A lasting note that has faded below this strength (0 to 1) drops back to a recent note. Higher demotes lasting notes more readily.", label: "Demote core notes below" },
  "brain.memory.notes.drop_below": { help: "A recent note that has faded below this strength (0 to 1) is forgotten, and a note this weak is also never shown to the co-host. Higher forgets faster.", label: "Forget notes below" },
  "brain.memory.notes.returning_strength": { help: "When a note about something you deleted without giving a reason is written again, it starts at this strength (0 to 1) instead of full, so a topic you removed returns only faintly.", label: "Restart strength of a deleted note" },
  "brain.memory.notes.suppress_similarity": { help: "How close a new note must be to one you deleted with a stated reason, from 0 to 1, before it is dropped as the same thing. Lower blocks more look-alike notes but may also block ones you wanted." },
  "brain.memory.notes.capture_min_chars": { help: "Chat lines and remarks shorter than this are not even considered for a viewer note, which skips greetings and one-word replies.", unit: "chars" },
  "brain.memory.notes.max_notes_per_viewer": { help: "The most notes about one viewer that are shown to the co-host in a reply. The strongest are chosen; higher gives more personal detail but a longer prompt." },
  "brain.memory.notes.max_notes_total": { help: "The most notes about all viewers together that are shown to the co-host in one reply, so a busy chat cannot flood the prompt." },
  "brain.memory.notes.sensitive_cooldown_hours": { help: "Notes about health or family are brought up at most this often, and only when replying to that viewer, so the co-host does not keep returning to a delicate topic.", unit: "hours" },
  "brain.memory.notes.deleted_retention_days": { help: "How long a note you deleted without giving a reason is remembered as deleted (so a new look-alike comes back faintly) before that record is wiped completely.", unit: "days" },
  ...hook("brain.memory.notes.capture", {
    kind: "How a viewer's chat line is turned into a note: rules writes no note at all, llm asks a small language model to decide, http sends the line to a server you run. If the chosen judge fails, no note is written for that line.",
    url: "Only for kind http: the address of your own server that decides what note to keep. Each request carries the viewer's chat line and their existing notes, so only point it somewhere you trust.",
    timeout: "How long to wait for the model or your server to answer for one chat line before giving up on a note for it.",
    modelKind: "small", what: "note capture",
  }),
  ...hook("brain.memory.notes.consolidator", {
    kind: "How the tidy-up pass over new notes is done (merging duplicates, fixing wording, rechecking whether a note is sensitive): rules proposes no change, llm asks a stronger language model, http sends it to a server you run. If the chosen judge fails, nothing is changed.",
    url: "Only for kind http: the address of your own server that tidies notes. Each request carries a viewer's notes, so only point it somewhere you trust.",
    timeout: "How long to wait for the model or your server to finish tidying one viewer's notes before giving up and leaving them unchanged.",
    modelKind: "chat", what: "the note tidy-up",
  }),

  // ---- brain.cortex
  "brain.cortex.recall_timeout_ms": { help: "How long the co-host waits for memory to answer before writing its reply without it. Lower keeps replies quick when memory is slow; higher waits longer so slow memories still make it in.", unit: "ms" },
  "brain.cortex.speaking_timeout_ms": { help: "How long the co-host waits for its voice to report that a line has finished playing before it gives up and carries on. It is a safety net for a voice that never answers; raise it if your lines are very long.", unit: "ms" },
  "brain.cortex.fallback_ack_chance": { help: "After a line fails to play and a fallback line is said instead, the co-host is told this chance (0 to 1) of joking about the glitch in its next reply. It is a nudge to the model, not a guaranteed rate; 0 means it is never told.", label: "Chance to joke about a glitch" },
  "brain.cortex.repeat_similarity": { help: "How alike a new reply may be to something the co-host said recently, from 0 to 1, before it stays silent instead of repeating itself. Lower blocks looser look-alikes and may also drop lines you wanted; 0 turns the check off.", label: "Repeat check" },
  // @spec CFG-PRES-015
  "brain.cortex.clause_min_chars": { help: "The shortest piece of a long reply that may be spoken on its own, in characters. A streamed reply is spoken clause by clause, so the first words reach the listener sooner; lower starts sooner but sounds more clipped.", label: "Shortest spoken clause", unit: "chars" },
  "brain.cortex.clause_max_chars": { help: "The longest piece of a reply spoken as one clause, in characters. A longer run of words is cut at the last word boundary before this limit. It may not be below the shortest clause.", label: "Longest spoken clause", unit: "chars" },
  "brain.cortex.max_clauses": { help: "How many clauses one reply may be spoken in before the co-host stops there. It bounds how long a single answer can run on, from 1 to 16.", label: "Most clauses per reply" },
  ...hook("brain.cortex.critic", {
    kind: "An editor that checks each reply before it is spoken: rules lets every reply through, llm asks a language model to block or fix it, http sends it to a server you run. If the chosen judge fails, the reply is spoken unchecked.",
    url: "Only for kind http: the address of your own server that checks replies. Each request carries the reply and the recent conversation, so only point it somewhere you trust.",
    timeout: "How long to wait for the model or your server to check a reply before speaking it unchecked. Keep it short, since the co-host waits while it checks.",
    modelKind: "small", what: "the reply checking",
  }),

  // ---- voice
  "voice.engine": { help: "kokoro speaks the replies with the Kokoro voice server; stub makes silent clips of the right length and calls no voice server, for testing the rest of the stack." },
  "voice.voice": { help: "The Kokoro voice the co-host speaks with, or a blend of voices such as af_bella(2)+af_sky, where the number is how much of that voice to mix in. The voice id starts with its language and gender, for example af for American female.", widget: { type: "voice" } },
  "voice.speed": { help: "How fast the co-host talks, as a multiplier from 0.25 to 4: 1 is the voice's normal pace, higher is faster and lower is slower." },
  "voice.lang_code": { help: "The language Kokoro uses to read the text, which decides how words are pronounced. Leave empty to use the language that matches the voice's first letter.", widget: { type: "options", options: [
    lang("a", "American English"), lang("b", "British English"), lang("e", "Spanish"), lang("f", "French"), lang("h", "Hindi"),
    lang("i", "Italian"), lang("j", "Japanese"), lang("p", "Brazilian Portuguese"), lang("z", "Mandarin Chinese"),
  ] }, label: "Language" },
  "voice.volume_multiplier": { help: "How loud the voice server makes the speech, from 0 (silent) to 10; 1 is its normal level. Leave empty to keep the server's own default. The speech output's gain adjusts loudness again afterwards.", label: "Voice volume" },
  "voice.normalization.normalize": { help: "Master switch for the voice server's text clean-up. Off sends the text to the voice exactly as written; on applies the switches below. The clean-up runs for English voices only; other languages are spoken as written whatever the switches say. Leave empty to keep the voice server's own default (on)." },
  "voice.normalization.unit_normalization": { help: "Reads a number with a unit as words, so 10KB is spoken as 10 kilobytes. The voice server's own default is off. Leave empty to keep it.", label: "Read units as words" },
  "voice.normalization.url_normalization": { help: "Reads web addresses aloud in words, so https://test.org/path is spoken as https test dot org slash path. Turn it off and the voice fumbles the address as written. Leave empty to keep the voice server's own default (on).", label: "Read web addresses" },
  "voice.normalization.email_normalization": { help: "Reads email addresses aloud in words, so user@example.com is spoken as user at example dot com. Leave empty to keep the voice server's own default (on).", label: "Read email addresses" },
  "voice.normalization.optional_pluralization_normalization": { help: "Turns an optional plural written with (s) into the plural, so friend(s) is spoken as friends. Leave empty to keep the voice server's own default (on).", label: "Read optional plurals" },
  "voice.normalization.phone_normalization": { help: "Reads a phone number as spoken digits, so 555-123-4567 is spoken digit by digit in groups instead of as one large number. Leave empty to keep the voice server's own default (on).", label: "Read phone numbers" },
  "voice.normalization.caps_normalization": { help: "Reads long words written in capitals as ordinary words instead of spelling them out letter by letter, so ARNE SAKNUSSEMM is spoken as two words; short acronyms such as FBI are still spelled out. Leave empty to keep the voice server's own default (on).", label: "Handle capitalised words" },
  "voice.normalization.replace_remaining_symbols": { help: "Speaks the symbols left after the other clean-up as words, so & is spoken as and and @ as at; without it the voice meets the raw symbols. Leave empty to keep the voice server's own default (on).", label: "Read leftover symbols" },
  "voice.normalization.remove_emoji": { help: "Drops emoji from the text instead of letting the voice read each one out by name. It works for every language, whatever the master switch says. The voice server's own default is off. Leave empty to keep it.", label: "Remove emoji" },
  "voice.sample_rate": { help: "Read only by the stub voice engine, to set the sample rate of the silent clips it makes; the Kokoro engine ignores it, so changing it does nothing to a real voice.", unit: "Hz" },
  "voice.fallback.lines": { help: "Lines the co-host says aloud when a reply fails to play; one is picked at random. The voice service turns each into a clip at its next start, so edits apply after a restart. An empty list turns the feature off, and each line is at most 200 characters.", label: "Fallback lines" },

  // ---- avatar
  "avatar.driver": { help: "Which avatar app the co-host drives: vtube-studio talks to VTube Studio, vmc sends to a VMC receiver, and null means no avatar app, so the co-host is dashboard-only." },
  "avatar.fps": { help: "How many times per second the avatar's pose is updated. Higher looks smoother but sends more updates to the avatar app.", unit: "fps", label: "Update rate" },
  "avatar.smoothing": { help: "How quickly the avatar's head, eyes and expression move toward their target, from 0 to 1. Higher is snappier and more abrupt; lower is slower and more floaty." },
  "avatar.idle_motion": { help: "When on, the avatar's head and eyes drift gently while the co-host is idle, and a bit more while it talks, so it never looks frozen. Off keeps it still apart from blinking and speaking." },
  "avatar.vtube_studio.host": { help: "The computer VTube Studio runs on. On the same machine as Docker use host.docker.internal; for a second PC use its address on your network. The saved VTube Studio token is sent to this address, so only point it somewhere you trust.", sensitive: true, label: "VTube Studio host" },
  "avatar.vtube_studio.port": { help: "The port of VTube Studio's plugin API, shown in its settings. The saved VTube Studio token is sent to this port, so only point it somewhere you trust.", sensitive: true, label: "VTube Studio port" },
  "avatar.vtube_studio.plugin_name": { help: "The plugin name VTube Studio shows when it asks you to allow the co-host. With the developer name it is what VTube Studio ties its saved permission to, so keep it fixed or you will be asked to allow it again.", label: "Plugin name" },
  "avatar.vtube_studio.plugin_developer": { help: "The developer name VTube Studio shows with the plugin. With the plugin name it is what VTube Studio ties its saved permission to, so keep it fixed or you will be asked to allow it again.", label: "Plugin developer" },
  "avatar.vmc.host": { help: "The computer running the VMC receiver (the app that receives the avatar's movements). Use host.docker.internal for the same machine, or its address on your network for another PC.", label: "VMC host" },
  "avatar.vmc.port": { help: "The port the VMC receiver listens on. It must match the port set in the receiving app.", label: "VMC port" },

  // ---- ears
  "ears.sources": { help: "Where the co-host listens: discord (the Discord voice channel), http (audio clips posted to the web address below), dir (audio files dropped in a folder), or the name of another connector such as desktop. All the ones listed are active at once; empty turns hearing off.", widget: { type: "sources" } },
  "ears.http.host": { help: "The network address the http audio source listens on. 127.0.0.1 accepts clips only from this computer; 0.0.0.0 accepts them from other devices too, in which case set a token (inside Docker use 0.0.0.0 and publish the port).", label: "HTTP listen address" },
  "ears.http.port": { help: "The port the http audio source listens on; clips are posted to /audio on it. 0 picks a free port.", label: "HTTP listen port" },
  "ears.http.token": { help: "A password that clips posted to the http audio source must carry. Leave empty to require none; set one if the port can be reached from other devices. It is stored in secrets.yaml and is never shown again once saved." },
  "ears.dir.path": { help: "The folder watched by the dir audio source: each .wav file dropped in is heard once and then renamed so it is not heard again. Empty means the dir source is not set up.", label: "Watched folder" },
  "ears.dir.poll_ms": { help: "How often the watched folder is checked for new files. Lower picks up a dropped file sooner; higher checks less often.", unit: "ms" },
  "ears.silence_ms": { help: "For sources that stream audio (such as Discord): how long someone must be quiet before their sentence counts as finished and is sent to be transcribed. Lower answers faster but may cut people off mid-pause; higher waits through longer pauses.", unit: "ms", label: "Silence that ends a sentence" },
  "ears.echo_suppress_sources": { help: "Sources that are muted while the co-host's own voice is playing, such as a desktop audio capture that would hear the co-host through your speakers and answer itself. Discord already filters its own voice, so it does not need to be listed.", widget: { type: "sources" } },
  "ears.echo_tail_ms": { help: "How long the sources above stay muted after a line finishes playing, to let the room echo die away. Higher is safer against the co-host hearing itself but may miss your first words.", unit: "ms" },
  "ears.vad.engine": { help: "How a streaming source's audio is cut into sentences: silero uses a speech detector that tells talking from background noise, and gap cuts on pauses in the audio alone, for connectors that only send audio while someone is speaking.", label: "Speech detector" },
  "ears.vad.threshold": { help: "With the silero detector: how sure it must be that a moment of audio is speech, from 0 to 1. Higher ignores more background noise but may miss quiet speech; lower catches quiet speech but may react to noise.", label: "Speech confidence" },
  "ears.max_utterance_ms": { help: "The longest a single sentence can run before it is cut off and sent for transcribing; the speaker's next words start a new one. Lower makes the co-host respond sooner to a long speech; higher keeps long sentences whole.", unit: "ms" },
  "ears.partials": { help: "When on, a partly spoken sentence is transcribed repeatedly while the person is still talking, which gives early text but costs extra speech-to-text work. Off waits until the sentence is finished." },
  "ears.stt_gpu": { help: "Say whether your speech-to-text server runs on a graphics card. It does not change how it runs; it only decides whether a warning is shown when partial transcription is on and the server might not keep up.", label: "Speech-to-text runs on a GPU" },
  "ears.partial_step_ms": { help: "With partials on: how often a growing sentence is transcribed again. Lower shows early text sooner but makes more speech-to-text requests.", unit: "ms" },
  "ears.min_speech_ms": { help: "Audio shorter than this is thrown away as noise or a cough instead of being transcribed. Higher ignores more short sounds but may drop a short answer like \"yes\".", unit: "ms" },
  "ears.stt_model": { help: "The speech-to-text model, named as your speech-to-text server knows it. A larger model hears more accurately but is slower, which delays the co-host's answer.", widget: { type: "model", kind: "stt" }, label: "Speech-to-text model" },
  "ears.stt_engine": { help: "speaches transcribes with a speech-to-text server; stub gives every clip the same fixed text and needs no server, for testing the rest of the stack.", label: "Speech-to-text engine" },
  "ears.drop_phrases": { help: "Transcripts that equal one of these lines are thrown away, ignoring capitals, spacing and punctuation at the ends. Use it for phrases the speech model invents out of silence, such as \"Thanks for watching!\". Empty drops nothing.", label: "Phrases to ignore" },

  // ---- mouth
  "mouth.outputs.discord.enabled": { help: "When on, the co-host's voice is played into the Discord voice channel. Off, nothing is played there." },
  "mouth.outputs.discord.gain_db": { help: "How much louder or quieter the co-host is in Discord, from -40 to 12 decibels. 0 leaves it unchanged, positive values are louder and negative values quieter.", unit: "dB", label: "Discord loudness" },
  "mouth.outputs.dryrun.enabled": { help: "A test output that accepts each line, plays nothing and reports it as done. Turn it on to try the co-host with no audio output." },
  "mouth.outputs.dryrun.fail_every": { help: "For the test output: 0 never fails; a number n makes every nth line fail on purpose, so you can see the spoken fallback line work." },
  "mouth.outputs.file.enabled": { help: "When on, every spoken line is also saved as a sound file in a folder, so you can listen back or use the audio elsewhere." },
  "mouth.outputs.file.dir": { help: "The folder the sound files are saved in, relative to the data folder (no absolute path and no ..).", label: "Folder" },
  "mouth.outputs.file.max_files": { help: "How many of the newest sound files are kept; older ones are deleted. Higher keeps a longer history and uses more disk." },
  "mouth.outputs.http.enabled": { help: "When on, every spoken line is also sent as audio to the web address below, for example to your own overlay or recorder." },
  "mouth.outputs.http.url": { help: "The web address each spoken line's audio is posted to (an http or https address). The co-host's voice goes to this address, so only point it somewhere you trust. Empty while the output is on leaves it down.", sensitive: true, label: "URL" },
  "mouth.outputs.http.timeout_ms": { help: "How long to wait for that address to accept one attempt before counting it as failed.", unit: "ms" },
  "mouth.outputs.http.retries": { help: "How many more attempts are made after the first fails, with a growing pause between them, before the line is dropped for this output." },
  "mouth.outputs.http.max_queue": { help: "How many lines may wait to be delivered if that address is slow. When it is full the oldest waiting line is dropped." },
  "mouth.fallback.min_interval_ms": { help: "The shortest time between spoken fallback lines on one output. When many lines fail at once this stops the co-host from reciting its fallback lines over and over; 0 allows one for every failure.", unit: "ms" },

  // ---- connections
  "connections.discord.enabled": { help: "When on, the Discord bot connects to your server's voice channel to hear people and speak. Off, the Discord connector stays idle and holds no connection." },
  "connections.discord.guild_id": { help: "The id of your Discord server (its \"guild\"), copied with Developer Mode on and written in quotes; a plain number would lose digits.", label: "Server id" },
  "connections.discord.voice_channel_id": { help: "The id of the voice channel the bot joins, copied with Developer Mode on and written in quotes.", label: "Voice channel id" },
  "connections.discord.token": { help: "The Discord bot's token, from the Discord developer portal; the bot must be invited with Connect and Speak permissions and the Server Members intent enabled. It is stored in secrets.yaml and is never shown again once saved.", label: "Bot token" },

  // ---- dashboard
  "dashboard.port": { help: "The port of the dashboard's full surface: the page you are using and its controls, including Launch and Stop. It applies at the dashboard's next start, and the page's address then changes to the new port." },
  "dashboard.lan_port": { help: "The port of the dashboard's LAN listener, which serves only the audio sink page and its audio so a second PC's OBS Browser Source can use it. It applies at the dashboard's next start and must differ from the main port.", label: "LAN port" },
  "dashboard.allowed_hosts": { help: "Machine names the dashboard accepts when another PC opens it by name instead of by IP address, for example streampc in an OBS Browser Source address such as http://streampc:3001/?sink=1. One per line, name only: no http://, no port. Addresses such as 192.168.1.20 and localhost always work. It applies at the dashboard's next start. It decides which names may reach the dashboard from your network, so only list machines you control.", sensitive: true, label: "Allowed host names" },
  "dashboard.inject.max_image_bytes": { help: "The largest picture the dashboard's test panel accepts when you send the co-host an image. A bigger upload is refused.", unit: "bytes" },
  "dashboard.inject.max_audio_bytes": { help: "The largest audio clip the dashboard's test panel accepts when you send the co-host something to hear. A bigger upload is refused.", unit: "bytes" },
  "dashboard.inject.ttl_ms": { help: "How long an uploaded test image or clip stays available for the service that asked for it; after that it is discarded. Raise it if a slow service needs longer to fetch it.", unit: "ms", label: "Upload lifetime" },
};

/** Every section's and key's presentation, keyed by declared section path and by dotted key path from the config root. */
export const PRESENTATION: { sections: Record<string, SectionPresentation>; keys: Record<string, KeyPresentation> } = { sections, keys };
