# Arrow: ears

The listening half of the co-host: it consumes connector audio sources (`discord`, `desktop` and any other tag a connector registers), the account-free `http` and `dir` capture sources and audio-upload injection, transcribes each utterance and publishes `speech.heard`. ears holds no Discord client or token and plays nothing; Discord audio in and out is the [connections](connections.md) segment, speaking is [mouth](mouth.md).

## Status

**AUDITED**, 2026-11-12: 59 specs, 56 implemented, 2 gaps (`[ ]`: the desktop capture helper, EARS-SRC-014 and 015, with CONN-DESK-001), 1 deferred (`[D]`: EARS-SRC-016, the helper writing frames to `audio.in.desktop`, CONN-DESK-002). Open work is the helper alone.

## Design

LLD: [ears-design.md](../intent/ears/ears-design.md) (Startup plans, Capture sources, Multiple sources, Connector sources, Decisions). Decision records: [listen-speak-split](../intent/ears/decisions/listen-speak-split.md), [connector-protocol](../intent/connections/decisions/connector-protocol.md).

- `ears.sources` is a list (default `[discord]`; empty is `off`), every entry started concurrently as its own `CaptureAdapter` with its own `deps.<source>` health (EARS-SRC-001 to 008, CFG-SCH-030). `EARS_SOURCES` overrides it in flow syntax (`[http, dir]`, `[]`).
- A connector source consumes `audio.in.<source>` frames and cuts utterances by `ears.silence_ms` of frame gap (EARS-CON-001 to 005); ears reads no Discord token and never loads `discord.js` (EARS-CON-002).
- `http` takes POSTed 16-bit PCM or WAV, `dir` takes WAV files dropped in a polled directory, both bounded by the shared inject limits and both working with `ears.stt_engine: stub` (EARS-CAP-*). A container serving `http` needs `ears.http.host: 0.0.0.0` and a published port, left to the operator.
- The `desktop` source is a connector whose clips arrive over the `http` listener until the capture helper writes frames (EARS-SRC-009 to 016, CONN-DESK-*).
- Injection (`inject.request`, kind `audio`) works in every plan (EARS-INJ-*, SHARED-INJ-*).

## References

### HLD
- docs/high-level-design.md (segments table, Audio sink arbitration)

### LLD
- docs/intent/ears/ears-design.md

### EARS
- docs/intent/ears/ears-specs.md (59 specs: 56 `[x]`, 2 `[ ]`, 1 `[D]`)

### Tests
- services/ears/test/*.test.ts (hearing and the STT client, transcript filter, plans and heartbeat, capture sources, connector source, injection limits, stub engine, `no-discord.test.ts` guarding that no Discord client or token is referenced)
- packages/config/test/config-ears-sources.test.ts, packages/config/test/config.test.ts (CFG-SCH-030)

### Code
- services/ears/src/{index,service,sources,session,health,hearing,transcript,audio,inject}.ts
- services/ears/src/{capture,capture-http,capture-dir,connector-source}.ts

## Architecture

**Purpose:** Turn every enabled audio source into `speech.heard` and transcribe uploaded audio on request. It plays nothing and never reads `voice.*` or `control`.

**Key Components:**
1. `index.ts` / `service.ts`: start through `runService`, choose the startup plan with `earsPlan`, wire the heartbeat and inject handler, register the one shutdown.
2. `sources.ts`, `capture.ts`: resolve `ears.sources` into adapters; `capture-http.ts`, `capture-dir.ts` and `connector-source.ts` are the adapters.
3. `session.ts`: the `ears` bus loop (`inject.request` only), group creation with start mode `latest`, the single shutdown sequence.
4. `hearing.ts`: min-length gate, 48k-to-16k conversion, STT HTTP client, `speech.heard` publish with the clip's `source`.
5. `audio.ts`, `inject.ts`, `health.ts`, `transcript.ts`: PCM downsampling over the shared WAV code, the inject handler, the plan and heartbeat, `ears.drop_phrases`.

## Key Findings

1. A source with no connector, or a `dir` source with no path, is `down` and logged while the others keep running; with no runnable source ears idles through the shared idle plan and still handles injection (EARS-SRC-005, EARS-SRC-008).
2. Bot accounts are never transcribed and her own lines never become `speech.heard`: the connector filters them (CONN-DISC-007).
3. `mute` / `pause` are ignored by ears by design; cortex and salience enforce them (EARS-HEAR-009).
4. The WAV parser and writer are shared with voice (`packages/shared/src/wav.ts`, SHARED-AUDIO-004).

## Work Required

### Must Fix
None.

### Should Fix
The desktop capture helper (EARS-SRC-014, 015, CONN-DESK-001) is not built; EARS-SRC-016 follows when it writes frames.
