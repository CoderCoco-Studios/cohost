---
title: Configuration
description: Every key of config.yaml, with its default, range and what it changes, grouped by section.
track: advanced
verified: f126b94
---

# Configuration reference

`config/config.yaml` holds all of cohost's behaviour: which model answers, the brain's timings, the voice, the avatar driver and where the co-host's voice goes. Secrets and per-machine settings live in `.env` instead; see [Environment and ports](env.md). This page lists every key of `config/config.example.yaml`, spelled as the dotted path it has in that file. Keys under a named entry are written out in full, such as `mouth.outputs.discord.gain_db`, and keys inside a list item use `[]`, such as `brain.salience.reflexes[].match`.

Terms used in the tables, defined once in the [glossary](../../start/glossary.md): [Ollama](../../start/glossary.md#ollama), [Postgres](../../start/glossary.md#postgres), [pgvector](../../start/glossary.md#pgvector), [embedding](../../start/glossary.md#embedding), [OBS](../../start/glossary.md#obs), [obs-websocket](../../start/glossary.md#obs-websocket), [Redis](../../start/glossary.md#redis), [bus](../../start/glossary.md#bus), [event](../../start/glossary.md#event), [hook](../../start/glossary.md#hook), [reflex](../../start/glossary.md#reflex), [connector](../../start/glossary.md#connector), [sink](../../start/glossary.md#sink), [Whisper](../../start/glossary.md#whisper), [Kokoro](../../start/glossary.md#kokoro), [VTube Studio](../../start/glossary.md#vtube-studio), [VMC](../../start/glossary.md#vmc), [valence and arousal](../../start/glossary.md#valence-arousal), [cortex](../../start/glossary.md#cortex), [salience](../../start/glossary.md#salience), [affect](../../start/glossary.md#affect), [STT](../../start/glossary.md#stt) and [GPU](../../start/glossary.md#gpu).

## How the file works

| Topic | Rule |
| --- | --- |
| The files | `config/config.example.yaml` is committed. `config/config.yaml` is yours and git-ignored: `scripts/install.sh` copies it, and any service that finds it missing copies it on first run. `personality.md` and `expressions.yaml` work the same way |
| Where it is read from | The `config/` folder at the workspace root (the nearest folder holding `pnpm-workspace.yaml`), whatever directory a service starts in. `CONFIG_DIR` overrides the folder |
| Placeholders | `${VAR}` is replaced from the environment, and `${VAR:-default}` falls back to `default` when `VAR` is unset or empty. A blank value that results means "use the schema's default" for most keys |
| When it applies | Every service reads the file once, at start. A change takes effect when the services that read it restart |
| Validation | Services check the file against the schema in `packages/config/src/schema.ts` and refuse to start on an error, naming the key. Unknown keys are ignored with a warning at start |
| Editing | The dashboard's Settings tab edits one section at a time from the same schema, keeps your comments and placeholders, never shows or writes secrets, refuses a save when the file changed under it, and offers to restart the services that read the section |
| Secrets | `llm.openai.api_key`, `llm.claude.api_key`, `vision.obs.password` and `ears.http.token` are secrets. The editor never shows them; set them through `.env` |

In the tables, "Env" names the environment variable that the example file reads for that key. The defaults shown are the schema's, and where the example file sets a different value that is noted.

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
| `llm` | map | The chat model |
| `llm.provider` | `ollama` | `ollama`, `openai`, `anthropic`, `bedrock` or `mock` (deterministic offline replies, for isolated runs only). Env: `LLM_PROVIDER` |
| `llm.model` | `qwen2.5:7b-instruct-q4_K_M` | The model id as the provider names it: an Ollama tag, an OpenAI-style id, `claude-opus-5-5`, `anthropic.claude-opus-5-5`. Env: `LLM_MODEL` |
| `llm.num_ctx` | `8192` | Ollama: the context window. Raise it with more VRAM |
| `llm.temperature` | `0.9` | Ollama and OpenAI: sampling temperature, 0 to 2 |
| `llm.max_tokens` | `120` | Ollama and OpenAI: reply length cap in tokens. Short replies read better as speech |
| `llm.timeout_ms` | `60000` | Request timeout for chat, embed and ping when the caller sets none |
| `llm.embed_model` | `nomic-embed-text` | The embedding model, always on Ollama. Env: `EMBED_MODEL` |
| `llm.openai` | map | Settings for `provider: openai` |
| `llm.openai.base_url` | `https://api.openai.com/v1` | Any OpenAI-compatible endpoint, such as `http://my-gpu-box:8000/v1` |
| `llm.openai.api_key` | `${LLM_API_KEY}` | The API key. A secret: the settings editor never shows or writes it |
| `llm.claude` | map | Settings for `provider: anthropic` and `provider: bedrock` |
| `llm.claude.api_key` | `${ANTHROPIC_API_KEY}` | The Claude API key. A secret. Empty uses `ANTHROPIC_API_KEY` or an `ant auth login` profile |
| `llm.claude.effort` | `low` | Thinking depth: `low`, `medium`, `high`, `xhigh` or `max`. `low` suits one-line replies |
| `llm.claude.max_tokens` | `2048` | Caps thinking and reply together, so keep it roomier than `llm.max_tokens`. Minimum 256 |
| `llm.claude.fallbacks` | `true` | Claude API only: retry on another Claude model if a safety classifier declines |
| `llm.bedrock` | map | Settings for `provider: bedrock` |
| `llm.bedrock.region` | `""` | The AWS region. Empty uses `AWS_REGION` or `AWS_DEFAULT_REGION` |

## `vision`

The `eyes` service: OBS screenshots described by a vision model.

| Key | Default | What it does |
| --- | --- | --- |
| `vision` | map | The eyes service |
| `vision.enabled` | `false` | `false` makes `eyes` idle and never touch OBS. Env: `VISION_ENABLED` |
| `vision.model` | `qwen2.5vl:3b` | The vision model. Required while `enabled` is true. Env: `VISION_MODEL` |
| `vision.engine` | `ollama` | `ollama` asks the vision model; `stub` answers with fixed text and no model. Env: `VISION_ENGINE` |
| `vision.interval_ms` | `8000` | How often to look at the game |
| `vision.temperature` | `0.2` | Vision model sampling temperature, 0 to 2 |
| `vision.num_predict` | `60` | The longest description the model may write, in tokens |
| `vision.jpeg_quality` | `70` | JPEG quality of the OBS screenshot, 1 to 100 |
| `vision.timeout_ms` | `30000` | Give up on a describe call after this long |
| `vision.upload_timeout_ms` | `10000` | Injected uploads: timeout for reading the image from Redis |
| `vision.upload_max_bytes` | `8388608` | Injected uploads: the largest image accepted (8 MiB) |
| `vision.prompt` | built-in prompt (commented out in the example) | The system prompt of the describe call. Blank uses the built-in one. Keep its rule to reply exactly `SAME` when nothing changed, or every reply counts as a change |
| `vision.obs` | map | The OBS connection |
| `vision.obs.host` | `host.docker.internal` | Where obs-websocket listens. Env: `OBS_HOST` |
| `vision.obs.port` | `4455` | The obs-websocket port. Env: `OBS_PORT` |
| `vision.obs.password` | empty | The obs-websocket password. A secret. Env: `OBS_PASSWORD` |
| `vision.obs.source` | `Game Capture` | The OBS source to screenshot. Env: `OBS_SOURCE` |
| `vision.obs.width` | `896` | Downscale the screenshot to this width before sending it to the model |

## `chat`

The `chat` service: Twitch chat in.

| Key | Default | What it does |
| --- | --- | --- |
| `chat` | map | The chat service |
| `chat.source` | `twitch` | `twitch`, or `fake` for scripted or stdin messages with no channel. Env: `CHAT_SOURCE` |
| `chat.fake` | map | Settings for `source: fake` |
| `chat.fake.interval_ms` | `8000` | The gap between scripted messages |
| `chat.twitch` | map | Settings for `source: twitch` |
| `chat.twitch.channel` | empty | The channel to read. Empty makes `chat` idle as `degraded`. Env: `TWITCH_CHANNEL` |
| `chat.ignore_users` | `[]` (`nightbot`, `streamelements`, `moobot` in the example) | Usernames whose messages are dropped |
| `chat.ignore_prefixes` | `["!"]` | Messages starting with any of these are dropped (bot commands) |

## `brain`

The four [brain regions](../../start/glossary.md#brain-region), which only talk over the bus.

| Key | Default | What it does |
| --- | --- | --- |
| `brain` | map | The brain |
| `brain.working_memory_events` | `24` | Recent events each region keeps as its working memory and prompt window |

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
| `brain.memory.store` | `postgres` | `postgres` (pgvector with Ollama embeddings) or `memory` (an in-process store, lost on exit). Env: `MEMORY_STORE` |
| `brain.memory.embedder` | `ollama` | `ollama` or `hash` (deterministic and offline). Env: `MEMORY_EMBEDDER` |
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
| `brain.cortex.critic` | map | The hook. See [Brain hooks](../extend/hooks.md) |
| `brain.cortex.critic.kind` | `rules` | `rules` (built in), `llm` (one chat call, JSON reply) or `http` (POST to your URL). A blank value means `rules` |
| `brain.cortex.critic.url` | `""` | `http` only: the endpoint to POST to, for example `http://host.docker.internal:8900/critic`. Required when `kind` is `http` |
| `brain.cortex.critic.timeout_ms` | `2500` in the example, `8000` when omitted | Give up on a call after this long; the rules answer instead |
| `brain.cortex.critic.llm` | map | `llm` only: which model answers. Empty reuses the `llm.*` model |
| `brain.cortex.critic.llm.provider` | `""` | `ollama`, `openai`, `anthropic` or `bedrock`. Needs `model` too |
| `brain.cortex.critic.llm.model` | `""` | The model id as that provider names it |

## `voice`

The `voice` service: text to speech.

| Key | Default | What it does |
| --- | --- | --- |
| `voice` | map | The voice service |
| `voice.engine` | `kokoro` | `kokoro`, or `stub` for a silent WAV sized from the text. Env: `VOICE_ENGINE` |
| `voice.voice` | `af_heart` | A Kokoro voice id, or a mix such as `af_bella(2)+af_sky` |
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
| `avatar.driver` | `null` | `vtube-studio`, `vmc` or `null` (no avatar app). Env: `AVATAR_DRIVER` |
| `avatar.fps` | `30` | Frames per second of the avatar engine |
| `avatar.smoothing` | `0.25` | 0 to 1; higher is snappier |
| `avatar.idle_motion` | `true` | Gentle head and eye drift when idle |
| `avatar.vtube_studio` | map | The VTube Studio driver |
| `avatar.vtube_studio.host` | required | Where VTube Studio runs. Env: `VTS_HOST` |
| `avatar.vtube_studio.port` | `8001` | The VTube Studio API port. Env: `VTS_PORT` |
| `avatar.vtube_studio.plugin_name` | `cohost` | The plugin name VTube Studio shows in its Allow dialog |
| `avatar.vtube_studio.plugin_developer` | `cohost` | The developer name shown there. The example uses `${TWITCH_CHANNEL}` |
| `avatar.vmc` | map | The VMC driver |
| `avatar.vmc.host` | required | Where the VMC receiver runs. Env: `VMC_HOST` |
| `avatar.vmc.port` | `39539` | The VMC receiver's UDP port. Env: `VMC_PORT` |

## `ears`

The `ears` service: audio in, speech-to-text, `speech.heard` out.

| Key | Default | What it does |
| --- | --- | --- |
| `ears` | map | The ears service |
| `ears.sources` | `[discord]` | The listening sources, all started at once and read at start: `discord`, `http`, `dir`, or another connector's source tag. An empty list idles. Env: `EARS_SOURCES`, in flow syntax such as `[http, dir]` |
| `ears.http` | map | The `http` source's listener |
| `ears.http.host` | `127.0.0.1` | The address to bind. In [Docker](../../start/glossary.md#docker) bind `0.0.0.0` and publish the port yourself |
| `ears.http.port` | `8765` | The port. 0 picks a free one |
| `ears.http.token` | `${EARS_HTTP_TOKEN:-}` | The bearer token `POST /audio` must carry. Empty requires none. A secret. Set it when others can reach the port |
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
| `ears.partials` | `off` | `on` publishes `speech.partial` while a connector utterance is open. It costs speech-to-text calls |
| `ears.stt_gpu` | `false` | Declare that the STT backend runs on a GPU. It only silences a start-up warning about partials |
| `ears.partial_step_ms` | `1000` | How often a growing partial transcription is made |
| `ears.min_speech_ms` | `400` | The shortest speech worth transcribing |
| `ears.stt_model` | `Systran/faster-whisper-small` | The model name sent to the STT server. Env: `STT_MODEL` |
| `ears.stt_engine` | `speaches` | `speaches`, or `stub` for a fixed transcript with no STT server. Env: `EARS_STT_ENGINE` |
| `ears.drop_phrases` | `[]` | Live transcripts equal to one of these (case, spacing and edge punctuation ignored) are dropped. They are Whisper's usual hallucinations on silence, such as `Thank you.` |

## `connections`

External connectors that attach to the bus.

| Key | Default | What it does |
| --- | --- | --- |
| `connections` | map | Connectors |
| `connections.discord` | map | The Discord connector (service `connector-discord`, `DISCORD_TOKEN`) |
| `connections.discord.enabled` | `true` | `false` makes the connector idle and hold no connection. Env: `CONNECTIONS_DISCORD_ENABLED` |
| `connections.discord.guild_id` | empty | The Discord server id. Env: `DISCORD_GUILD_ID` |
| `connections.discord.voice_channel_id` | empty | The voice channel id. Env: `DISCORD_VOICE_CHANNEL_ID` |

## `mouth`

The `mouth` service: where her voice goes. Each key under `mouth.outputs` is one output and its sink name.

| Key | Default | What it does |
| --- | --- | --- |
| `mouth` | map | The speaking module |
| `mouth.outputs` | map | The outputs |
| `mouth.outputs.discord` | map | Sink `discord`: the voice goes to the Discord connector and into the channel set under `connections.discord` |
| `mouth.outputs.discord.enabled` | `true` | `false` makes `mouth` play nothing on it. Env: `MOUTH_DISCORD_ENABLED` |
| `mouth.outputs.discord.gain_db` | `0` | Loudness on this output only, -40 to 12 dB. 0 is unchanged |
| `mouth.outputs.dryrun` | map | A test output that accepts each line, plays nothing and reports `voice.done` |
| `mouth.outputs.dryrun.enabled` | `false` | Turn it on. Env: `MOUTH_DRYRUN_ENABLED` |
| `mouth.outputs.dryrun.fail_every` | `0` | 0 never fails; N fails every Nth line, to exercise the fallback path |
| `mouth.outputs.file` | map | Appends each line's WAV to a folder under the data directory |
| `mouth.outputs.file.enabled` | `false` | Turn it on. Env: `MOUTH_FILE_ENABLED` |
| `mouth.outputs.file.dir` | `mouth/outputs` | The folder, relative to the data directory. No absolute path and no `..` |
| `mouth.outputs.file.max_files` | `100` | The newest this many files are kept |
| `mouth.outputs.http` | map | POSTs each line's WAV (`audio/wav`) to a URL |
| `mouth.outputs.http.enabled` | `false` | Turn it on. Env: `MOUTH_HTTP_ENABLED` |
| `mouth.outputs.http.url` | empty | An `http` or `https` URL. Empty while enabled leaves the output down. Env: `MOUTH_HTTP_URL` |
| `mouth.outputs.http.timeout_ms` | `5000` | Timeout per attempt |
| `mouth.outputs.http.retries` | `3` | Attempts after the first, with backoff |
| `mouth.outputs.http.max_queue` | `20` | Undelivered lines held; the oldest is dropped past this |
| `mouth.fallback` | map | The spoken fallback line |
| `mouth.fallback.min_interval_ms` | `20000` | At most one fallback line per this long on an output when many lines fail at once |

## `dashboard`

The host-run dashboard.

| Key | Default | What it does |
| --- | --- | --- |
| `dashboard` | map | The dashboard |
| `dashboard.port` | `3000` | The port the full dashboard listens on when `PORT` and `DASHBOARD_PORT` are both unset. Read at the dashboard's next start |

