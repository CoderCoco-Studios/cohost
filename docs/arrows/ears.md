# Arrow: ears

The listening half of the co-host: it consumes connector audio sources (`discord`, `desktop` and any other tag a connector registers), the account-free `http` and `dir` capture sources and audio-upload injection, transcribes each utterance and publishes `speech.heard`. ears holds no Discord client or token and plays nothing; Discord audio in and out is the [connections](connections.md) segment, speaking is [mouth](mouth.md).

## Status

**AUDITED**, 2026-11-12: 93 specs, 89 implemented (`[x]`), 2 gaps (`[ ]`: the desktop capture helper, EARS-SRC-014 and 015, with CONN-DESK-001), 2 deferred (`[D]`: EARS-PART-015, EARS-SRC-016, the helper writing frames to `audio.in.desktop`, CONN-DESK-002). Open work is the helper alone. New gaps from the docs site's extension guides: EARS-EX-001 to EARS-EX-007 (the example audio clients, the `curl` script and the conversion scripts); the spec file now holds 100 specs (89 `[x]`, 9 `[ ]`, 2 `[D]`).

## Design

LLD: [ears-design.md](../intent/ears/ears-design.md) (Startup plans, Capture sources, Multiple sources, Connector sources, Decisions). Decision records: [listen-speak-split](../intent/ears/decisions/listen-speak-split.md), [connector-protocol](../intent/connections/decisions/connector-protocol.md).

- `ears.sources` is a list (default `[discord]`; empty is `off`), every entry started concurrently as its own `CaptureAdapter` with its own `deps.<source>` health (EARS-SRC-001 to 008, CFG-SCH-030). `EARS_SOURCES` overrides it in flow syntax (`[http, dir]`, `[]`).
- A connector source consumes `audio.in.<source>` frames and cuts utterances with the endpointing engine `ears.vad.engine` names, `silero` (default) or the `ears.silence_ms` frame gap (EARS-CON-001 to 005, EARS-VAD-001 to 008); ears reads no Discord token and never loads `discord.js` (EARS-CON-002).
- `http` takes POSTed 16-bit PCM or WAV, `dir` takes WAV files dropped in a polled directory, both bounded by the shared inject limits and both working with `ears.stt_engine: stub` (EARS-CAP-*). A container serving `http` needs `ears.http.host: 0.0.0.0` and a published port, left to the operator.
- The `desktop` source is a connector whose clips arrive over the `http` listener until the capture helper writes frames (EARS-SRC-009 to 016, CONN-DESK-*).
- Injection (`inject.request`, kind `audio`) works in every plan (EARS-INJ-*, SHARED-INJ-*).

## Barge-in and echo gate

EARS-ECHO-001 to EARS-ECHO-009 are the echo gate for `ears.echo_suppress_sources`; EARS-INJ-012 stamps `meta.source` on an injected clip's `speech.heard`. Design: the HLD's Barge-in and echo gate protocol and Future / ideal state section.

## References

### HLD
- docs/high-level-design.md (segments table, Audio sink arbitration)

### LLD
- docs/intent/ears/ears-design.md

### EARS
- docs/intent/ears/ears-specs.md (100 specs: 89 `[x]`, 9 `[ ]`, 2 `[D]`; the gaps are the desktop helper, EARS-SRC-014 and 015; the Silero loader runs `onnxruntime-node` over the Silero VAD v5.1.2 model committed under `services/ears/models/`, pinned by `services/ears/test/silero.test.ts`)

### Spec Coverage

| IDs | Topic | Specs | Markers |
| --- | --- | --- | --- |
| EARS-START-001 to 008 | startup plans, consumer group | 6 | 6 `[x]` |
| EARS-HEAR-001 to 012 | listening and transcription, audio-end stamp | 11 | 11 `[x]` |
| EARS-VAD-001 to 008 | endpointing | 8 | 8 `[x]` |
| EARS-PART-001 to 015 | partial transcripts | 15 | 14 `[x]`, 1 `[D]` |
| EARS-CAP-001 to 012 | capture sources (`http`, `dir`) | 12 | 12 `[x]` |
| EARS-SRC-001 to 016 | multiple sources, desktop source | 15 | 12 `[x]`, 2 `[ ]`, 1 `[D]` |
| EARS-CON-001 to 005 | connector sources | 5 | 5 `[x]` |
| EARS-ECHO-001 to 009 | echo gate | 9 | 9 `[x]` |
| EARS-INJ-005 to 012 | audio injection | 7 | 7 `[x]` |
| EARS-STUB-001 to 002 | stub transcriber | 2 | 2 `[x]` |
| EARS-HLTH-001 to 003 | health | 3 | 3 `[x]` |

### Tests
- services/ears/test/*.test.ts (`audio`, `ears`, `filter`, `transcript`, `stub`, `loop`, `service`, `session`, `health`, `inject`, `inject-limits`, `capture`, `capture-http`, `capture-dir`, `connector-source`, `endpointing`, `partials`, `echo`, `timing`, `silero`, `no-discord`)
- packages/config/test/config-ears-sources.test.ts
- packages/bus/test/bus.test.ts

### Code
- services/ears/src/{index,service,sources,session,health,hearing,transcript,audio,inject}.ts
- services/ears/src/{capture,capture-http,capture-dir,connector-source,vad,echo}.ts
- packages/config/src/schema.ts

## Architecture

**Purpose:** Turn every enabled audio source into `speech.heard` and transcribe uploaded audio on request. It plays nothing, never reads `control`, and reads `voice.playing` and `voice.done` only for the echo gate.

**Key Components:**
1. `index.ts` / `service.ts`: start through `runService`, choose the startup plan with `earsPlan`, wire the heartbeat and inject handler, register the one shutdown.
2. `sources.ts`, `capture.ts`: resolve `ears.sources` into adapters; `capture-http.ts`, `capture-dir.ts` and `connector-source.ts` are the adapters.
3. `session.ts`: the `ears` bus loop (`inject.request`, plus `voice.playing` and `voice.done` for the echo gate), group creation with start mode `latest`, the single shutdown sequence.
4. `hearing.ts`: resampling of any clip rate to 16 kHz mono, min-length gate, STT HTTP client, echo-gate drop, `speech.heard` publish with the clip's `source`.
5. `vad.ts`, `echo.ts`: the Silero endpointing detector and the echo gate.
6. `audio.ts`, `inject.ts`, `health.ts`, `transcript.ts`: WAV header reading, the inject handler, the plan and heartbeat, `ears.drop_phrases`.

## Key Findings

1. A source with no connector, or a `dir` source with no path, is `down` and logged while the others keep running; with no runnable source ears idles through the shared idle plan and still handles injection (EARS-SRC-005, EARS-SRC-008).
2. Bot accounts are never transcribed and her own lines never become `speech.heard`: the connector filters them (CONN-DISC-007).
3. `mute` / `pause` are ignored by ears by design; cortex and salience enforce them (EARS-HEAR-009).
4. The WAV parser and writer are shared with voice (`packages/shared/src/audio.ts`: `parseWav`, `wavWrap`; test `packages/shared/test/wav.test.ts`; SHARED-AUDIO-004).

## Work Required

### Must Fix
None.

### Should Fix
- Build and test the example audio clients (EARS-EX-001..007), cited by the docs site's Extend pages (docs-site Extension guides).
The desktop capture helper (EARS-SRC-014, 015, CONN-DESK-001) is not built; EARS-SRC-016 follows when it writes frames.
