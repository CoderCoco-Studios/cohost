---
title: Configuration
description: Every key of config.yaml, with its default, range and what it changes, grouped by section.
track: advanced
verified: f126b94
---

# Configuration reference

`config/config.yaml` holds all of cohost's behaviour: which model answers, the brain's timings, the voice, the avatar driver and where the co-host's voice goes. Every value is a literal: no environment variable is read for any key. Credentials live in `config/secrets.yaml`, and `.env` holds only what must exist before configuration can be read plus the dashboard's access controls; see [Environment and ports](env.md). This page lists every key of `config/config.example.yaml`, spelled as the dotted path it has in that file. Keys under a named entry are written out in full, such as `mouth.outputs.discord.gain_db`, and keys inside a list item use `[]`, such as `brain.salience.reflexes[].match`.

Terms used in the tables, defined once in the [glossary](../../start/glossary.md): [Ollama](../../start/glossary.md#ollama), [Postgres](../../start/glossary.md#postgres), [pgvector](../../start/glossary.md#pgvector), [embedding](../../start/glossary.md#embedding), [OBS](../../start/glossary.md#obs), [obs-websocket](../../start/glossary.md#obs-websocket), [Redis](../../start/glossary.md#redis), [bus](../../start/glossary.md#bus), [event](../../start/glossary.md#event), [hook](../../start/glossary.md#hook), [reflex](../../start/glossary.md#reflex), [connector](../../start/glossary.md#connector), [sink](../../start/glossary.md#sink), [Whisper](../../start/glossary.md#whisper), [Kokoro](../../start/glossary.md#kokoro), [VTube Studio](../../start/glossary.md#vtube-studio), [VMC](../../start/glossary.md#vmc), [valence and arousal](../../start/glossary.md#valence-arousal), [cortex](../../start/glossary.md#cortex), [salience](../../start/glossary.md#salience), [affect](../../start/glossary.md#affect), [STT](../../start/glossary.md#stt) and [GPU](../../start/glossary.md#gpu).

## How the file works

| Topic | Rule |
| --- | --- |
| The files | `config/config.example.yaml` is committed. `config/config.yaml` is yours and git-ignored: `scripts/install.sh` copies it, and any service that finds it missing copies it on first run. `personality.md` and `expressions.yaml` work the same way |
| Where it is read from | The `config/` folder at the workspace root (the nearest folder holding `pnpm-workspace.yaml`), whatever directory a service starts in. `CONFIG_DIR` overrides the folder, and `secrets.yaml` sits beside `config.yaml` in it |
| Literal values | Every value is written as a literal. A `${...}` placeholder anywhere in `config.yaml` is refused when the file loads, with a message naming the key, and the service does not start. A blank value means "use the schema's default" for most keys |
| When it applies | Every service reads the file once, at start. A change takes effect when the services that read it restart |
| Validation | Services check the file against the schema in `packages/config/src/schema.ts` and refuse to start on an error, naming the key. Unknown keys are ignored with a warning at start |
| Editing | The dashboard's Settings screen edits one section at a time from the same schema, keeps your comments, shows a secret only as set or not set (and writes it to `secrets.yaml` through its own route, never to `config.yaml`), refuses a save when the file changed under it, and offers to restart the services that read the section |
| Secrets | The eleven credential keys listed under [Credentials](#credentials-secrets-yaml) live in `config/secrets.yaml`, not here. A credential written in `config.yaml` is ignored |

The defaults shown are the schema's, and where the example file sets a different value that is noted.

## `cohost`

Who the co-host is and who it talks to.

| Key | Default | What it does |
| --- | --- | --- |
| `cohost` | map | Identity |
| `cohost.name` | required (`Coco` in the example) | How the co-host refers to itself and is addressed in chat |
| `cohost.streamer` | required (`Chris` in the example) | Your name, as the language model should know it |
| `cohost.timezone` | `UTC` (`America/New_York` in the example) | The timezone the co-host uses for times and dates |

## `llm`

Which model answers for the co-host. Embeddings always use local Ollama whatever the provider is, so the memory vectors never change size when the chat model does. Ranges are enforced when the config loads.

| Key | Default | What it does |
| --- | --- | --- |
| `llm` | map | The chat model |
| `llm.provider` | `ollama` | `ollama`, `openai`, `anthropic`, `bedrock` or `mock` (deterministic offline replies, for isolated runs only) |
| `llm.model` | `qwen2.5:7b-instruct-q4_K_M` | The model id as the provider names it: an Ollama tag, an OpenAI-style id, `claude-opus-5-5`, `anthropic.claude-opus-5-5` |
| `llm.num_ctx` | `8192` | Ollama: the context window. Raise it with more VRAM |
| `llm.temperature` | `0.9` | Ollama and OpenAI: sampling temperature, 0 to 2 |
| `llm.max_tokens` | `120` | Ollama and OpenAI: reply length cap in tokens. Short replies read better as speech |
| `llm.timeout_ms` | `60000` | Request timeout for chat, embed and ping when the caller sets none |
| `llm.embed_model` | `nomic-embed-text` | The embedding model, always on Ollama |
| `llm.openai` | map | Settings for `provider: openai` (the API key is in `secrets.yaml`) |
| `llm.openai.base_url` | `https://api.openai.com/v1` | Any OpenAI-compatible endpoint, such as `http://my-gpu-box:8000/v1` |
| `llm.claude` | map | Settings for `provider: anthropic` and `provider: bedrock` (the Claude API key is in `secrets.yaml`) |
| `llm.claude.effort` | `low` | Thinking depth: `low`, `medium`, `high`, `xhigh` or `max`. `low` suits one-line replies |
| `llm.claude.max_tokens` | `2048` | Caps thinking and reply together, so keep it roomier than `llm.max_tokens`. Minimum 256 |
| `llm.claude.fallbacks` | `true` | Claude API only: retry on another Claude model if a safety classifier declines |
| `llm.bedrock` | map | Settings for `provider: bedrock` |
| `llm.bedrock.region` | `""` | The AWS region of the Bedrock endpoint, such as `us-east-1`. Required for `provider: bedrock`, together with the access key id and secret access key in `secrets.yaml`; an empty region leaves Bedrock not configured |

## `vision`

The `eyes` service: OBS screenshots described by a vision model.

| Key | Default | What it does |
| --- | --- | --- |
| `vision` | map | The eyes service |
| `vision.enabled` | `false` | `false` makes `eyes` idle and never touch OBS |
| `vision.model` | `qwen2.5vl:3b` | The vision model. Ollama pulls it while `provider` is `ollama`; blank means none, and eyes reports it down while `enabled` is true |
| `vision.provider` | `ollama` | `ollama`, `openai`, `anthropic` or `bedrock` (hosted, with their keys in `secrets.yaml`), or `stub` for fixed text and no model |
| `vision.interval_ms` | `8000` | How often to look at the game |
| `vision.temperature` | `0.2` | Vision model sampling temperature, 0 to 2 |
| `vision.num_predict` | `60` | The longest description the model may write, in tokens |
| `vision.jpeg_quality` | `70` | JPEG quality of the OBS screenshot, 1 to 100 |
| `vision.timeout_ms` | `30000` | Give up on a describe call after this long |
| `vision.upload_timeout_ms` | `10000` | Injected uploads: timeout for reading the image from Redis |
| `vision.upload_max_bytes` | `8388608` | Injected uploads: the largest image accepted (8 MiB) |
| `vision.prompt` | built-in prompt (commented out in the example) | The system prompt of the describe call. Blank uses the built-in one. Keep its rule to reply exactly `SAME` when nothing changed, or every reply counts as a change |
| `vision.obs` | map | The OBS connection (the obs-websocket password is `vision.obs.password` in `secrets.yaml`) |
| `vision.obs.host` | `host.docker.internal` | Where obs-websocket listens |
| `vision.obs.port` | `4455` | The obs-websocket port |
| `vision.obs.source` | `Game Capture` | The OBS source to screenshot |
| `vision.obs.width` | `896` | Downscale the screenshot to this width before sending it to the model |

## `chat`

The `chat` service: chat in from the sources listed in `chat.sources`. The Twitch channel and the YouTube video are here; their credentials are in `secrets.yaml`.

| Key | Default | What it does |
| --- | --- | --- |
| `chat` | map | The chat service |
| `chat.sources` | `[twitch]` | The chat sources read at once: any of `twitch`, `youtube` and `fake` (scripted or stdin messages with no channel), in a list. Empty turns chat off; a name listed twice is read once; any other name fails the load naming `chat.sources` |
| `chat.fake` | map | Settings for the `fake` source |
| `chat.fake.interval_ms` | `8000` | The gap between scripted messages |
| `chat.twitch` | map | Settings for the `twitch` source (the credentials are `chat.twitch.*` keys of `secrets.yaml`); optional, every key defaults |
| `chat.twitch.channel` | empty | The channel to read. Empty makes `chat` idle as `degraded` |
| `chat.youtube` | map | Settings for the `youtube` source; optional, every key defaults |
| `chat.youtube.video` | empty | The YouTube video or live stream whose chat is read: any string (a video id, a link or a handle). A value that names no video is a source gap, not a load failure |
| `chat.youtube.api_key` | empty | The YouTube Data API key. A secret: it is a `chat.youtube.api_key` key of `secrets.yaml`, never of `config.yaml` |
| `chat.youtube.transport` | `stream` | `stream` reads the live chat stream; `poll` asks for new messages on an interval. Blank is `stream`; any other value fails the load naming `chat.youtube.transport` |
| `chat.youtube.poll_floor_ms` | `12000` | Transport `poll`: the shortest gap between two chat polls, in milliseconds. An integer of at least 1000 |
| `chat.youtube.recheck_ms` | `120000` | How often the video is checked again for a live chat, in milliseconds. An integer of at least 30000 |
| `chat.ignore_users` | `[]` (`nightbot`, `streamelements`, `moobot` in the example) | Usernames whose messages are dropped |
| `chat.ignore_prefixes` | `["!"]` | Messages starting with any of these are dropped (bot commands) |

## `brain`

The four [brain regions](../../start/glossary.md#brain-region), which only talk over the bus.

| Key | Default | What it does |
| --- | --- | --- |
| `brain` | map | The brain |
| `brain.working_memory_events` | `24` | Recent events each region keeps as its working memory and prompt window. Must stay above `brain.working_memory_own_lines` (default 4) |
| `brain.working_memory_own_lines` | `4` | How many of the co-host's own recent lines the window never drops, so a flood of chat cannot push them out. An integer of at least 1 that must be less than `brain.working_memory_events`; otherwise the file fails to load |

## `brain.input_limits`

The longest text a speech engine or the vision model may hand to a prompt. Longer text is cut to the limit.

| Key | Default | What it does |
| --- | --- | --- |
| `brain.input_limits` | map | The speech and screen text limits. The section is optional |
| `brain.input_limits.speech_max_chars` | `1000` | The longest spoken transcript a prompt carries, in characters. At least 16 |
| `brain.input_limits.vision_max_chars` | `500` | The longest screen description a prompt carries, in characters. At least 16 |

## `brain.salience`

When to speak, and reflexes. The region scores unseen events at a poll every `tick_ms` and at once when a finished line of speech arrives. A mention scores 1.0, speech 0.9, a question 0.55, a moderator or subscriber 0.35, a screen change 0.3 and plain chat 0.15.

| Key | Default | What it does |
| --- | --- | --- |
| `brain.salience` | map | The salience region |
| `brain.salience.tick_ms` | `1500` | The poll: a decision pass every this often. It is the only starter for chat, vision and idle chatter |
| `brain.salience.trigger_on_speech` | `true` | Decide at once when a final speech line arrives instead of waiting for the next poll |
| `brain.salience.barge_in` | `false` | Stop the voice when someone speaks over the co-host, and answer the interrupter |
| `brain.salience.barge_in_sources` | `[discord]` | Listening sources whose speech may interrupt: `http`, `dir` or a connector tag |
| `brain.salience.barge_in_min_words` | `2` | Words a line needs to interrupt ("mm-hm" does not count) |
| `brain.salience.cooldown_ms` | `6000` | The minimum gap between utterances |
| `brain.salience.thinking_timeout_ms` | `60000` | Stop treating the cortex as busy after this long without a reply |
| `brain.salience.idle_chatter_ms` | `90000` | Speak unprompted when quiet this long and there is something new it has not reacted to. 0 turns it off |
| `brain.salience.reply_on_mention` | `true` | Always respond when the co-host's name is used |
| `brain.salience.speak_threshold` | `0.6` | The summed event score needed to speak |
| `brain.salience.arousal_bias` | `0.2` | An excited mood lowers the threshold by up to this much, 0 to 1 |
| `brain.salience.module` | map | The hook. See [Brain hooks](../extend/hooks.md) |
| `brain.salience.module.kind` | `rules` | `rules` (built in), `llm` (one chat call, JSON reply) or `http` (POST to your URL). A blank value means `rules` |
| `brain.salience.module.url` | `""` | `http` only: the endpoint to POST to, for example `http://host.docker.internal:8900/salience`. Required when `kind` is `http` |
| `brain.salience.module.timeout_ms` | `8000` | Give up on a call after this long; the rules answer instead |
| `brain.salience.module.llm` | map | `llm` only: which model answers. Empty reuses the `llm.*` model |
| `brain.salience.module.llm.provider` | `""` | `ollama`, `openai`, `anthropic` or `bedrock`. Needs `model` too |
| `brain.salience.module.llm.model` | `""` | The model id as that provider names it |
| `brain.salience.reflexes` | `[]` | A list of canned reactions that fire the instant a matching event lands, with no model. Each item has the keys below |
| `brain.salience.reflexes[].match` | required | A case-insensitive regular expression tested against the event text |
| `brain.salience.reflexes[].on` | `[chat, speech, vision]` | Which senses it listens to |
| `brain.salience.reflexes[].say` | required | A list of lines; one is picked at random |
| `brain.salience.reflexes[].emotion` | `surprised` | The emotion the line is said with |
| `brain.salience.reflexes[].gesture` | none | An optional avatar gesture |
| `brain.salience.reflexes[].cooldown_ms` | `30000` | This reflex's own cooldown |
| `brain.salience.reminder_expiry_ms` | `1800000` | How long past its due time a reminder may still be spoken; a later one is dropped |

## `brain.affect`

The mood: a valence and arousal pair that drifts back to a baseline.

| Key | Default | What it does |
| --- | --- | --- |
| `brain.affect` | map | The affect region |
| `brain.affect.publish_ms` | `2000` | How often `affect.state` goes out while the mood is moving |
| `brain.affect.half_life_ms` | `45000` | A mood swing fades halfway back to baseline in this long |
| `brain.affect.baseline_valence` | `0.15` | The resting valence, -1 to 1. A sunny co-host sits above 0 |
| `brain.affect.baseline_arousal` | `0.1` | The resting arousal, 0 to 1 |
| `brain.affect.republish_ms` | `15000` | An unchanged mood is sent again this often so late joiners get a value |
| `brain.affect.short_line_chars` | `4` | `llm` and `http` hooks only: shorter lines with no mention are judged by the built-in rules |
| `brain.affect.count_window_ms` | `30000` | A viewer, or a text, moves the mood at most once in this long. A positive integer |
| `brain.affect.nudge_sub_valence` | `0.05` | Valence nudge, 0 to 1, for a subscriber's chat line |
| `brain.affect.nudge_sub_arousal` | `0.05` | Arousal nudge for a subscriber's chat line |
| `brain.affect.nudge_screen_arousal` | `0.08` | Arousal nudge for a changed screen |
| `brain.affect.nudge_said_valence` | `0.08` | Valence nudge for the co-host's own happy (up) or sad or angry (down) line |
| `brain.affect.nudge_said_arousal` | `0.05` | Arousal nudge for any line the co-host says |
| `brain.affect.module` | map | The hook. See [Brain hooks](../extend/hooks.md) |
| `brain.affect.module.kind` | `rules` | `rules` (built in), `llm` (one chat call, JSON reply) or `http` (POST to your URL). A blank value means `rules` |
| `brain.affect.module.url` | `""` | `http` only: the endpoint to POST to, for example `http://host.docker.internal:8900/affect`. Required when `kind` is `http` |
| `brain.affect.module.timeout_ms` | `8000` | Give up on a call after this long; the rules answer instead |
| `brain.affect.module.llm` | map | `llm` only: which model answers. Empty reuses the `llm.*` model |
| `brain.affect.module.llm.provider` | `""` | `ollama`, `openai`, `anthropic` or `bedrock`. Needs `model` too |
| `brain.affect.module.llm.model` | `""` | The model id as that provider names it |

## `brain.memory`

The `memory` region: the only one that touches Postgres.

| Key | Default | What it does |
| --- | --- | --- |
| `brain.memory` | map | The [memory region](../../start/glossary.md#memory-region) |
| `brain.memory.store` | `postgres` | `postgres` (pgvector with Ollama embeddings) or `memory` (an in-process store, lost on exit) |
| `brain.memory.embedder` | `ollama` | `ollama` or `hash` (deterministic and offline) |
| `brain.memory.recall_k` | `6` | Memories pulled per prompt. 0 turns recall off |
| `brain.memory.min_similarity` | `0.35` | The lowest similarity a memory may have to be recalled, 0 to 1 |
| `brain.memory.regular_messages` | `25` | Lifetime messages above which a viewer counts as a regular. The owner can also flag one |
| `brain.memory.notes` | map | Viewer notes: short, fading notes about each viewer |
| `brain.memory.notes.dirty_threshold` | `20` | Unconsolidated notes that start a consolidation pass |
| `brain.memory.notes.recent_half_life_days` | `7` | A recent note loses half its strength this often |
| `brain.memory.notes.core_half_life_days` | `60` | A core note does too, more slowly |
| `brain.memory.notes.reinforce` | `0.6` | A repeat mention closes this fraction of the gap to full strength, 0 to 1 |
| `brain.memory.notes.promote_mentions` | `3` | Mentions that turn a recent note into a core one |
| `brain.memory.notes.demote_below` | `0.3` | A core note weaker than this falls back to recent |
| `brain.memory.notes.drop_below` | `0.1` | A recent note weaker than this is forgotten |
| `brain.memory.notes.returning_strength` | `0.3` | A topic you deleted without a reason comes back this weak |
| `brain.memory.notes.suppress_similarity` | `0.8` | The similarity at which a note matches a deletion that had a reason |
| `brain.memory.notes.capture_min_chars` | `8` | Chat lines shorter than this are not considered for notes |
| `brain.memory.notes.max_notes_per_viewer` | `5` | Notes the cortex is shown per viewer |
| `brain.memory.notes.max_notes_total` | `15` | Notes the cortex is shown in all |
| `brain.memory.notes.sensitive_cooldown_hours` | `24` | Health and family notes are surfaced at most this often |
| `brain.memory.notes.deleted_retention_days` | `30` | Deletions made without a reason are forgotten after this long |
| `brain.memory.notes.capture` | map | The hook. See [Brain hooks](../extend/hooks.md) |
| `brain.memory.notes.capture.kind` | `rules` | `rules` (built in), `llm` (one chat call, JSON reply) or `http` (POST to your URL). A blank value means `rules` |
| `brain.memory.notes.capture.url` | `""` | `http` only: the endpoint to POST to, for example `http://host.docker.internal:8900/capture`. Required when `kind` is `http` |
| `brain.memory.notes.capture.timeout_ms` | `20000` | Give up on a call after this long; the rules answer instead |
| `brain.memory.notes.capture.llm` | map | `llm` only: which model answers. Empty reuses the `llm.*` model |
| `brain.memory.notes.capture.llm.provider` | `""` | `ollama`, `openai`, `anthropic` or `bedrock`. Needs `model` too |
| `brain.memory.notes.capture.llm.model` | `""` | The model id as that provider names it |
| `brain.memory.notes.consolidator` | map | The hook. See [Brain hooks](../extend/hooks.md) |
| `brain.memory.notes.consolidator.kind` | `rules` | `rules` (built in), `llm` (one chat call, JSON reply) or `http` (POST to your URL). A blank value means `rules` |
| `brain.memory.notes.consolidator.url` | `""` | `http` only: the endpoint to POST to, for example `http://host.docker.internal:8900/consolidate`. Required when `kind` is `http` |
| `brain.memory.notes.consolidator.timeout_ms` | `60000` | Give up on a call after this long; the rules answer instead |
| `brain.memory.notes.consolidator.llm` | map | `llm` only: which model answers. Empty reuses the `llm.*` model |
| `brain.memory.notes.consolidator.llm.provider` | `""` | `ollama`, `openai`, `anthropic` or `bedrock`. Needs `model` too |
| `brain.memory.notes.consolidator.llm.model` | `""` | The model id as that provider names it |

## `brain.cortex`

The only region that calls the chat model.

| Key | Default | What it does |
| --- | --- | --- |
| `brain.cortex` | map | The cortex region |
| `brain.cortex.recall_timeout_ms` | `2500` | Answer without memories if the memory region is slow or down |
| `brain.cortex.speaking_timeout_ms` | `20000` | Stop waiting on a voice sink that never reports done |
| `brain.cortex.fallback_ack_chance` | `0.25` | The base chance, 0 to 1, that she riffs on a line that failed to play. A nudge stated to the model, not an enforced rate |
| `brain.cortex.repeat_similarity` | `0.8` | Stay silent rather than say a line this similar, 0 to 1, to a recent one. 0 turns the check off |
| `brain.cortex.clause_min_chars` | `24` | The shortest piece of a streamed reply spoken on its own, in characters; at least 1 |
| `brain.cortex.clause_max_chars` | `160` | The longest piece spoken as one clause, in characters; not below `clause_min_chars` |
| `brain.cortex.max_clauses` | `8` | How many clauses one reply may be spoken in before the co-host stops there, 1 to 16 |
| `brain.cortex.critic` | map | The hook. See [Brain hooks](../extend/hooks.md) |
| `brain.cortex.critic.kind` | `rules` | `rules` (built in), `llm` (one chat call, JSON reply) or `http` (POST to your URL). A blank value means `rules` |
| `brain.cortex.critic.url` | `""` | `http` only: the endpoint to POST to, for example `http://host.docker.internal:8900/critic`. Required when `kind` is `http` |
| `brain.cortex.critic.timeout_ms` | `2500` in the example, `8000` when omitted | Give up on a call after this long; the rules answer instead |
| `brain.cortex.critic.llm` | map | `llm` only: which model answers. Empty reuses the `llm.*` model |
| `brain.cortex.critic.llm.provider` | `""` | `ollama`, `openai`, `anthropic` or `bedrock`. Needs `model` too |
| `brain.cortex.critic.llm.model` | `""` | The model id as that provider names it |

## `viewer_text`

The longest text a viewer may hand to a prompt. Longer text is cut to the limit. The whole section is optional.

| Key | Default | What it does |
| --- | --- | --- |
| `viewer_text` | map | The chat message and viewer name limits |
| `viewer_text.max_chars` | `500` | The longest chat message a prompt carries, in characters. 500 is Twitch's own message limit. At least 16 |
| `viewer_text.max_name_chars` | `40` | The longest viewer name a prompt carries, in characters. At least 8 |

## `voice`

The `voice` service: text to speech. Which engine to choose, and what each sends over the network, is in [Choose a voice engine](../../guide/tune/voice-engine.md).

| Key | Default | What it does |
| --- | --- | --- |
| `voice` | map | The voice service |
| `voice.engine` | `kokoro` | `kokoro`, `openai` (an OpenAI-compatible speech server), `pocket` (a Pocket speech server), or `stub` for a silent WAV sized from the text |
| `voice.voice` | `af_heart` (`alba` under `pocket`) | Under `kokoro`, a voice id or a mix such as `af_bella(2)+af_sky`; under `pocket`, a catalogue name or an http(s) URL; under `openai`, any voice name. Blank takes the engine's own default, and stays blank under `openai` |
| `voice.timeout_ms` | `15000` | The bound on the wait for the first audio byte of a synthesis, and on each gap between its chunks |
| `voice.openai.base_url` | `""` | The base URL of the OpenAI-compatible speech server, for `engine: openai`. Trailing slashes are dropped |
| `voice.openai.model` | `""` | The speech model name the server takes, for `engine: openai` |
| `voice.openai.api_key` | `""` | The server's API key. A secret, in `secrets.yaml` |
| `voice.pocket` | map | The Pocket speech server |
| `voice.pocket.url` | `http://tts-pocket:8000` | The Pocket speech server, for `engine: pocket`. Blank is a configuration gap |
| `voice.pocket.hf_token` | `""` | The Hugging Face token for the gated Pocket weights. A secret, in `secrets.yaml` |
| `voice.speed` | `1.05` | The pace multiplier, 0.25 to 4 |
| `voice.sample_rate` | `24000` | The sample rate of the silence the stub engine returns. The Kokoro engine ignores it |
| `voice.lang_code` | unset (commented out in the example) | The Kokoro language code: `a`, `b`, `e`, `f`, `h`, `i`, `j`, `p` or `z`. Blank derives it from the voice name |
| `voice.volume_multiplier` | unset (commented out in the example) | Output gain sent to Kokoro-FastAPI, 0 to 10. Unset keeps the server's default |
| `voice.normalization` | unset (commented out in the example) | A map of text clean-up switches before synthesis. A key left out keeps the server's default |
| `voice.normalization.normalize` | unset | Switch for general normalisation |
| `voice.normalization.unit_normalization` | unset | Switch for units |
| `voice.normalization.url_normalization` | unset | Switch for URLs |
| `voice.normalization.email_normalization` | unset | Switch for email addresses |
| `voice.normalization.optional_pluralization_normalization` | unset | Switch for optional plurals |
| `voice.normalization.phone_normalization` | unset | Switch for phone numbers |
| `voice.normalization.caps_normalization` | unset | Switch for capitalised words |
| `voice.normalization.replace_remaining_symbols` | unset | Switch for leftover symbols |
| `voice.normalization.remove_emoji` | unset | Switch for emoji removal |
| `voice.fallback` | map | The spoken fallback lines |
| `voice.fallback.lines` | 15 lines in the example | Lines said aloud when a line fails to play. `voice` regenerates the clips at its next start. An empty list turns the feature off. Each line is at most 200 characters |

## `avatar`

The `avatar` service.

| Key | Default | What it does |
| --- | --- | --- |
| `avatar` | map | The avatar service |
| `avatar.driver` | `null` | `vtube-studio`, `vmc`, `browser` (the browser renderer in the [container](../../start/glossary.md#container) `avatar`) or `null` (no avatar app, dashboard only). A blank value means `null` |
| `avatar.fps` | `30` | Frames per second of the avatar engine |
| `avatar.smoothing` | `0.25` | 0 to 1; higher is snappier |
| `avatar.idle_motion` | `true` | Gentle head and eye drift when idle |
| `avatar.vtube_studio` | map | The VTube Studio driver |
| `avatar.vtube_studio.host` | `host.docker.internal` | Where VTube Studio runs: `host.docker.internal` on the same machine as Docker, the LAN address on a second PC |
| `avatar.vtube_studio.port` | `8001` | The VTube Studio API port |
| `avatar.vtube_studio.plugin_name` | `cohost` | The plugin name VTube Studio shows in its Allow dialog |
| `avatar.vtube_studio.plugin_developer` | `cohost` | The developer name shown there. With `plugin_name` it is what VTube Studio ties its saved permission to, so keep it fixed |
| `avatar.vmc` | map | The VMC driver |
| `avatar.vmc.host` | `host.docker.internal` | Where the VMC receiver runs: `host.docker.internal` on the same machine, the LAN address on another PC |
| `avatar.vmc.port` | `39539` | The VMC receiver's UDP port |

## `renderer`

The browser renderer's model and framing, read when `avatar.driver` is `browser`. A running renderer applies a saved change without a restart. The section is optional: an absent key takes its default.

| Key | Default | Meaning |
|---|---|---|
| `renderer.model` | `""` | A `.vrm` file name from the dashboard's model store: a letter or digit first, then letters, digits, spaces, dots, underscores or hyphens, ending in `.vrm`, at most 80 characters. Empty draws the built-in placeholder model |
| `renderer.zoom` | `1` | Camera distance, `0.5` to `3` |
| `renderer.offset_y` | `0` | Vertical framing offset, `-1.5` to `1.5` |
| `renderer.turn` | `0` | Yaw in degrees, `-90` to `90` |

## `ears`

The `ears` service: audio in, speech-to-text, `speech.heard` out.

| Key | Default | What it does |
| --- | --- | --- |
| `ears` | map | The ears service |
| `ears.sources` | `[discord]` | The listening sources, all started at once and read at start: `discord`, `http`, `dir`, or another connector's source tag. An empty list idles. Written in flow syntax such as `[http, dir]` |
| `ears.http` | map | The `http` source's listener. Its bearer token is `ears.http.token` in `secrets.yaml`; empty requires none, so set one when others can reach the port |
| `ears.http.host` | `127.0.0.1` | The address to bind. In [Docker](../../start/glossary.md#docker) bind `0.0.0.0` and publish the port yourself |
| `ears.http.port` | `8765` | The port. 0 picks a free one |
| `ears.dir` | map | The `dir` source |
| `ears.dir.path` | empty | The directory to watch, created if missing. Empty means not configured, and `ears` idles as `degraded` |
| `ears.dir.poll_ms` | `1000` | How often to look for new `.wav` files |
| `ears.silence_ms` | `700` | End-of-utterance detection |
| `ears.echo_suppress_sources` | `[desktop]` | Sources that are deaf while the co-host's voice plays, because a loopback capture hears it |
| `ears.echo_tail_ms` | `1500` | Keep them deaf this long after a line ends |
| `ears.vad` | map | Voice activity detection for connector audio |
| `ears.vad.engine` | `silero` | `silero` (the Silero VAD model, run by onnxruntime) or `gap` (cut on the frame gap alone) |
| `ears.vad.threshold` | `0.5` | The speech probability a frame needs, 0 to 1 |
| `ears.max_utterance_ms` | `15000` | An utterance is cut at this length; the speaker's next speech opens a new one |
| `ears.partials` | `off` | `on` publishes `speech.partial` while a connector utterance is open. With a batch engine each partial is a speech-to-text call; with a streaming engine the partials come from the session's hypotheses at no extra call |
| `ears.stt_gpu` | `false` | Declare that the batch STT backend runs on a GPU. It only silences the start-up warning about partials of a batch engine; a streaming engine never warns |
| `ears.partial_step_ms` | `1000` | With a batch engine, how often a growing partial transcription is made; with a streaming engine, the pacing window between published partials |
| `ears.min_speech_ms` | `400` | The shortest speech worth transcribing |
| `ears.stt_model` | `Systran/faster-whisper-small` | The model name sent to the STT server |
| `ears.stt_engine` | `speaches` | `speaches`, `openai`, `nemotron`, `kyutai`, or `stub` for a fixed transcript with no STT server |
| `ears.stt_fallback_engine` | `speaches` | `speaches`, `openai` or `none`: the batch engine for whole clips a streaming engine (`nemotron`, `kyutai`) cannot serve |
| `ears.stt_timeout_ms` | `20000` | The bound on one speech-to-text call: a batch request, a streaming session's connect (aborted at the bound), a readiness ping, and a session's `finish()`. The buffered start of a session is bounded the same way |
| `ears.max_stt_sessions` | `2` | How many speech-to-text sessions run at once (at least 1) |
| `ears.openai.base_url` | `""` | The base URL of an OpenAI-compatible transcription server, for `openai`. Trailing slashes are dropped |
| `ears.openai.api_key` | `""` | Its API key. A secret, in `secrets.yaml` |
| `ears.nemotron` | map | The NVIDIA Nemotron speech-to-text server |
| `ears.nemotron.url` | `http://stt-nemotron:8080` | The NVIDIA Nemotron STT server, for `stt_engine: nemotron`. Blank is a configuration gap |
| `ears.nemotron.api_key` | `""` | Its API key, if it asks for one. A secret, in `secrets.yaml` |
| `ears.kyutai` | map | The Kyutai speech-to-text server |
| `ears.kyutai.url` | `http://stt-kyutai:8080` | The Kyutai STT server, for `stt_engine: kyutai`. Blank is a configuration gap |
| `ears.kyutai.api_key` | `""` | Its API key, if it asks for one. A secret, in `secrets.yaml` |
| `ears.kyutai.end_of_turn` | `off` | `on` lets the server's end-of-turn signal close an utterance early, at the last frame received, at most once and only after a word; `off` leaves the close to ears' own endpointing. Ignored under `ears.vad.engine: gap` |
| `ears.kyutai.end_of_turn_threshold` | `0.5` | The end-of-turn probability (the third `Step` probability) needed, above 0 and below 1 |
| `ears.drop_phrases` | `[]` | Live transcripts equal to one of these (case, spacing and edge punctuation ignored) are dropped. They are Whisper's usual hallucinations on silence, such as `Thank you.` |

## `connections`

External connectors that attach to the bus.

| Key | Default | What it does |
| --- | --- | --- |
| `connections` | map | Connectors |
| `connections.discord` | map | The Discord connector (service `connector-discord`); the bot token is `connections.discord.token` in `secrets.yaml` |
| `connections.discord.enabled` | `true` | `false` makes the connector idle and hold no connection |
| `connections.discord.guild_id` | empty | The Discord server id |
| `connections.discord.voice_channel_id` | empty | The voice channel id |

## `mouth`

The `mouth` service: where her voice goes. Each key under `mouth.outputs` is one output and its sink name.

| Key | Default | What it does |
| --- | --- | --- |
| `mouth` | map | The speaking module |
| `mouth.outputs` | map | The outputs |
| `mouth.outputs.discord` | map | Sink `discord`: the voice goes to the Discord connector and into the channel set under `connections.discord` |
| `mouth.outputs.discord.enabled` | `true` | `false` makes `mouth` play nothing on it |
| `mouth.outputs.discord.gain_db` | `0` | Loudness on this output only, -40 to 12 dB. 0 is unchanged |
| `mouth.outputs.dryrun` | map | A test output that accepts each line, plays nothing and reports `voice.done` |
| `mouth.outputs.dryrun.enabled` | `false` | Turn it on |
| `mouth.outputs.dryrun.fail_every` | `0` | 0 never fails; N fails every Nth line, to exercise the fallback path |
| `mouth.outputs.file` | map | Appends each clause's WAV to a folder under the data directory, named `<epoch-ms>-<n>-<id>-<seq>.wav` |
| `mouth.outputs.file.enabled` | `false` | Turn it on |
| `mouth.outputs.file.dir` | `mouth/outputs` | The folder, relative to the data directory. No absolute path and no `..` |
| `mouth.outputs.file.max_files` | `100` | The newest this many files are kept |
| `mouth.outputs.http` | map | POSTs each clause's WAV (`audio/wav`, headers `x-cohost-utterance-id` and `x-cohost-clause`) to a URL |
| `mouth.outputs.http.enabled` | `false` | Turn it on |
| `mouth.outputs.http.url` | empty | An `http` or `https` URL. Empty while enabled leaves the output down |
| `mouth.outputs.http.timeout_ms` | `5000` | Timeout per attempt |
| `mouth.outputs.http.retries` | `3` | Attempts after the first, with backoff |
| `mouth.outputs.http.max_queue` | `20` | Undelivered clauses held; the oldest is dropped past this |
| `mouth.fallback` | map | The spoken fallback line |
| `mouth.fallback.min_interval_ms` | `20000` | At most one fallback line per this long on an output when many lines fail at once |

## `dashboard`

The host-run dashboard. Its access controls (`DASHBOARD_HOST`, `CONTROL_TOKEN` and the rest) stay in `.env`; see [Environment and ports](env.md).

| Key | Default | What it does |
| --- | --- | --- |
| `dashboard` | map | The dashboard |
| `dashboard.port` | `3000` | The port of the dashboard's full surface (page, controls, Launch and Stop). Read at the dashboard's next start |
| `dashboard.lan_port` | `3001` | The port of the LAN listener (the sink page and audio for a second PC's OBS). Must differ from `dashboard.port`. Read at the dashboard's next start |
| `dashboard.allowed_hosts` | `[]` | Machine names the dashboard accepts when another PC opens it by name instead of by IP address, such as `streampc` in the address of the second PC's OBS sink page. IP addresses and `localhost` always work. Read at the dashboard's next start. Changing it from the settings screen needs the control token, because it widens who may reach the dashboard |
| `dashboard.inject` | map | The limits of the test-upload panel |
| `dashboard.inject.max_image_bytes` | `8388608` | The largest image accepted, in bytes |
| `dashboard.inject.max_audio_bytes` | `26214400` | The largest audio clip accepted, in bytes |
| `dashboard.inject.ttl_ms` | `300000` | How long an upload stays available to the service that asked for it |
| `dashboard.models` | map | The model store for browser-renderer `.vrm` files |
| `dashboard.models.max_bytes` | `104857600` | The largest `.vrm` file accepted, in bytes: 1 MiB (`1048576`) to 1 GiB (`1073741824`) |

## `network`

The machines that count as your own network, for the egress rule: which destinations of private data are on the LAN and which are off it.

| Key | Default | What it does |
| --- | --- | --- |
| `network` | unset | The optional network section |
| `network.lan` | `[]` | Host names (`nas`), single addresses (`203.0.113.7`), dot suffixes (`.ts.net`) and CIDR ranges (`100.64.0.0/10`) counted as LAN. A bad entry fails naming `network.lan.<n>` |

Private addresses, `localhost`, `host.docker.internal`, dotless names and `.local` names are on the LAN without an entry.

## `tools`

The MCP servers the co-host may call and the tools it may use. Nothing is enabled by absence: a tool runs only when `tools.allow` names it with `enabled: true`, and a server is called only for such a tool. Every server's token lives in `secrets.yaml` (`tools.servers.<name>.token`), never here.

| Key | Default | What it does |
| --- | --- | --- |
| `tools.mode` | `live` | `live` calls the configured servers; `mock` returns canned results and calls none. A blank value is `live` |
| `tools.timeout_ms` | `10000` | Limit of one tool call before it counts as failed (ms, positive) |
| `tools.confirm_timeout_ms` | `20000` | How long a request to confirm an acting tool waits for an answer (ms, positive) |
| `tools.max_result_chars` | `1500` | Longest tool result that reaches the prompt (at least 64) |
| `tools.max_concurrent` | `4` | Tool calls running at once across all servers (at least 1) |
| `tools.catalog_ms` | `30000` | How often each server's tool list is read again (at least 5000 ms) |
| `tools.max_tools_per_server` | `32` | Tools taken from one server's list (at least 1) |
| `tools.max_tools` | `64` | Tools in the catalogue across all servers (at least 1) |
| `tools.owner_sources` | `all` | `all`, or a list of listening source names whose speech counts as the owner's. Names follow `ears.sources` |
| `tools.servers` | `{}` | Map from server name to its entry. A name is lower-case letters, digits and hyphens, starting with a letter, at most 32 characters. Sensitive: the addresses are sent private data |
| `tools.servers.<name>.url` | required | An `http` or `https` address with no user name or password. A query parameter named `key`, `token`, `api_key`, `apikey`, `secret`, `auth`, `password` or `access_token` loads with one warning naming the server and the parameter |
| `tools.servers.<name>.header` | `""` | The HTTP header the token is sent in. Blank means `Authorization` |
| `tools.servers.<name>.external` | `false` | `true` treats the server as off the LAN whatever its host, for the egress rule |
| `tools.allow` | `{}` | Map from tool name (`server__tool`, letters, digits, `_` and `-`, at most 64 characters) to its permission. Sensitive |
| `tools.allow.<name>.enabled` | `false` | Whether the co-host may call this tool |
| `tools.allow.<name>.acts` | `false` | The tool acts on something outside the chat |
| `tools.allow.<name>.chat` | `false` | The tool speaks in chat. Cannot be true together with `acts` |
| `tools.allow.<name>.confirm` | `true` | Ask the owner to confirm before an acting tool runs |
| `tools.allow.<name>.hash` | `""` | The tool's definition hash, which the tools unit reads; empty by default |
| `tools.allow.<name>.effect` | `read` | `read`, `acts` or `unlabelled`. Read only when `tools.mode` is `mock` |
| `tools.timer` | map | The timer limits |
| `tools.timer.max_active` | `5` | Timers the co-host may have running at once (at least 1) |
| `tools.timer.max_minutes` | `120` | Longest timer, in minutes (at least 1) |
| `tools.stream_info` | map | The stream information the co-host may read |
| `tools.stream_info.cache_ms` | `30000` | How long the stream's title and game are remembered; 0 reads them every time |
| `tools.reply` | map | The limits on the tool calls one reply may make |
| `tools.reply.max_rounds` | `3` | Rounds of tool calls one reply may take (at least 1) |
| `tools.reply.max_calls` | `3` | Tool calls one reply may make in all (at least 1) |
| `tools.reply.budget_ms` | `30000` | Time one reply may spend on tool calls in all (at least 1 ms) |
| `tools.reply.filler_after_ms` | `1500` | A call still running after this long gets a filler line; 0 says one at once |
| `tools.reply.max_tokens` | `512` | The longest model answer, in tokens, for one tool-using step (at least 1) |
| `tools.reply.filler_lines` | six lines | Lines said at random while a tool runs; each at most 200 characters. An empty list says none |

A failed load names the key (`tools.servers.<name>.url`, `tools.allow.<name>`, and so on) and never quotes a URL or the user name and password in it.

## Credentials (`secrets.yaml`)

`config/secrets.yaml` holds exactly these keys, and nothing else is read from it. It is git-ignored, mode 0600 (`scripts/install.sh` creates it from `config/secrets.example.yaml`), sits beside `config.yaml` and is merged into the loaded config, so a service reads each as the dotted path it has here. A secret written in `config.yaml` is ignored. The settings editor never shows or writes them, and the dashboard reports each only as set or not set; edit the file by hand and restart the services that read it. Write each value as a string, and leave a credential you do not use as `""`.

| Key | Default | What it is |
| --- | --- | --- |
| `llm.openai.api_key` | `""` | The API key of the endpoint named by `llm.openai.base_url`, for `provider: openai` |
| `llm.claude.api_key` | `""` | A Claude API key, for `provider: anthropic` |
| `llm.bedrock.access_key_id` | `""` | An AWS access key id, for `provider: bedrock`. Needs `llm.bedrock.region` and the secret access key too |
| `llm.bedrock.secret_access_key` | `""` | The secret access key that goes with the access key id |
| `vision.obs.password` | `""` | The obs-websocket password. Empty when the server needs none |
| `ears.http.token` | `""` | The bearer token `POST /audio` must carry. Empty requires none |
| `chat.twitch.client_id` | `""` | The Twitch application's client id |
| `chat.twitch.client_secret` | `""` | The Twitch application's client secret |
| `chat.twitch.access_token` | `""` | A user access token for the bot account. `chat` keeps its refreshed copy under the data directory |
| `chat.twitch.refresh_token` | `""` | Its refresh token. Required whenever `access_token` is set |
| `ears.openai.api_key` | `""` | The API key of the OpenAI-compatible transcription server |
| `ears.nemotron.api_key` | `""` | The key of the Nemotron STT server, if it asks for one |
| `ears.kyutai.api_key` | `""` | The key of the Kyutai STT server, if it asks for one |
| `voice.openai.api_key` | `""` | The API key of the OpenAI-compatible speech server |
| `voice.pocket.hf_token` | `""` | The Hugging Face token for the gated Pocket weights; only an owner who has accepted them needs it |
| `chat.youtube.api_key` | `""` | The YouTube Data API key for the YouTube chat source |
| `connections.discord.token` | `""` | The co-host's one Discord bot token, used only by the Discord connector. Invite the bot with Connect and Speak and enable the Server Members intent |
| `tools.servers.<name>.token` | `""` | The credential sent to the MCP server named `<name>` in `config.yaml`, in the header `tools.servers.<name>.header` names. A token for a server `config.yaml` does not hold is not merged and is listed by path in the warning about keys that are not secret keys |
