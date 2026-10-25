## Context

Perception services publish `chat.message`, `vision.summary`, `speech.heard`; the brain (salience, affect, memory, cortex) consumes them. Dashboard (`services/dashboard/src/routes.ts`, plain `node:http`) has `POST /control` and proxies `GET /audio/*` from voice (`VOICE_URL`); voice publishes `voice.utterance.audioUrl` as a path, binaries never ride the stream. Eyes (`Eyes.look` -> `ollamaDescriber`) and ears (`Hearing`, `sttTranscriber`) have injectable describe/transcribe functions; chat has `createChatFilter`. None of chat/eyes/ears subscribes to the bus today (they only publish), so each needs a new consumer group.

## Decisions

### D1. Two levels, one UI
- **service level**: dashboard stores the upload and publishes `inject.request`; the target service runs its real code path and publishes the normal event with `injected: true`.
- **bus level**: dashboard publishes the perception event itself (`source: "dashboard"`, `injected: true`). Only text is meaningful here (`vision.summary` and `speech.heard` need no pixels or audio). So bus level goes through `POST /inject/text` with `as: "chat"|"speech"|"vision"`; `POST /inject/image|audio` with `level: bus` is a 400 pointing at `/inject/text`. Service level via `/inject/text` supports only `as: chat` (there is no perception code to run for speech/vision text); other values are a 400.

### D2. URL on the bus, not base64
Binary stays out of Redis (stream is `MAXLEN ~20k`, replayed to every group and to `bus.recent(60)` backfill for each dashboard WebSocket client; a 5 MB image would be copied into all of that). The upload store serves `GET /uploads/:id`; `inject.request.url` carries `${DASHBOARD_URL}/uploads/<id>`. This mirrors `voice.utterance.audioUrl`.
- Alternative: base64 in the event. Rejected: stream bloat, WebSocket fan-out of megabytes, log noise, zod payload limits.
- Alternative: shared volume/tmp path. Rejected: breaks across containers/hosts, services are meant to be location-independent.
- `urls.dashboard()` is new: `envOr("DASHBOARD_URL", "http://127.0.0.1:3000")`. Compose sets `http://dashboard:3000` for eyes/ears. `urls` has no dashboard entry today (checked `packages/config/src/index.ts`); `VOICE_URL` is read ad hoc in voice/dashboard.
- **SSRF guard**: eyes/ears fetch a URL taken from the bus, so they MUST only fetch URLs under `urls.dashboard()` + `/uploads/`; anything else is `ok:false`. Upload ids are 128-bit random (capability URL), and `GET /uploads/:id` is unauthenticated because services have no token; ids are never listed.

### D3. Upload store
In-memory `Map`: per-kind caps (image 8 MiB, audio 25 MiB), TTL 10 min (swept lazily on access and by interval), at most 16 entries and 64 MiB total (oldest evicted). Tmp dir rejected: needs cleanup on crash, no benefit for test-sized files. Content types allowed: image `png|jpeg|webp`; audio `wav|mpeg|ogg|webm|mp4`/`x-wav` (MediaRecorder produces webm/opus; the OpenAI-compatible STT server decodes common containers). Unsupported type 415, too large 413 (checked on `Content-Length` and while streaming).

### D4. Raw body, not multipart
`POST /inject/image?level=service&remember=1` with `Content-Type: image/png` and the file as body. Rationale: no multipart parser dependency (repo is plain `node:http`; dependency rules prefer not adding packages for this), browser `fetch(url, {method:"POST", body: file})` and `MediaRecorder` blobs send raw bodies natively, and curl is `--data-binary`. Cost: options live in the query string instead of form fields; fine for three scalar flags. Optional `user`/`speaker` query param labels the speaker for audio. Multipart rejected for parser cost; base64 JSON rejected (33% overhead, same bloat concerns).

### D5. `inject.result`: keep it
Without it, failures are invisible: a missing `vision.summary` could mean eyes down, model unreachable, SAME-suppressed, or STT 500, indistinguishable by the operator. Heartbeat `deps` (add-service-health) says a service is degraded in general but not that this request failed or why, and is optional. `inject.result {id, ok, detail?}` is tiny, correlates by `id` (the dashboard's response includes it and the UI matches it on the existing `/ws` feed), and also gives a success acknowledgement with detail (e.g. the produced text). Cost: one more event type. The dashboard does not block the HTTP call on it (202 `{id}`); the UI shows the result when it arrives, and shows "no response from <target> after 10 s" client-side if none comes (service down/not subscribed).

### D6. `remember` and `injected` placement
Both are optional fields on the three perception payloads, `remember` meaningful only when `injected` is true (ignored otherwise, so a real event can never be hidden from memory). Alternative: carry `remember` only on `inject.request` and let services drop it. Rejected: memory consumes the resulting event, not the request, so the flag has to travel on the event. Alternative: a separate wrapper event. Rejected: every consumer would need to learn it. Absent and `false` behave identically for both fields (no `.default(false)`, to keep real events byte-identical).

### D7. Behaviour of injected events downstream
Salience, affect, cortex see ordinary events (that is the point). Memory: `injected && !remember` -> do not `remember`, do not touch `viewers`, do not publish `memory.viewer`. Note `memory` baseline does not store `vision.summary`, so `remember` is currently a no-op for vision; it is still carried so a future vision memory honours it. Known gap: `brain.say` replies to an injected event are stored as `self` memories (they carry no flag); marking them is out of scope (Open Question 1).

### D8. Service handlers
- **eyes**: subscribe group `eyes`, types `[inject.request]`, handle `target==="eyes" && kind==="image"`. Fetch URL, base64 it, call the same `describe(b64, "")` (previous = "" so injection neither sees SAME nor disturbs the change-tracking `previous`). Empty/`SAME` reply -> `ok:false` "no description". Works with `vision.enabled=false`: OBS is never needed; if the vision model backend is unreachable, `ok:false` with the error. Publishes `vision.summary {text, changed:true, injected:true, remember}`.
- **ears**: subscribe group `ears`, handle audio. Fetch bytes, post as-is to STT (container formats are decoded server-side); `durationMs` from the WAV header when WAV, else 0. `min_speech_ms` does not apply (that gates Discord PCM). Empty/non-word transcript -> `ok:false`. `speaker` = `meta.user` or `"injected"`. Works with `ears.source: off` (STT is reached over HTTP; Discord client not required).
- **chat**: subscribe group `chat`, handle text. Publishes `chat.message` with `platform` (default `twitch`), `user` (default `injected_viewer`), `isMod`/`isSub` (default false), `mentionsCohost` computed from `cohost.name`, text whitespace-normalized. `ignore_users` / `ignore_prefixes` are NOT applied (a test that is silently dropped is useless); blank text -> `ok:false`. Works with `chat.source` twitch/fake and with no channel (isolated).
- **Staleness**: groups resume after a restart, so handlers drop `inject.request` whose envelope `ts` is older than 60 s (`ok:false` "stale") rather than replaying old uploads (which would also have expired).
- **Wiring seam**: handlers are pure functions taking `{bus: Publisher, fetch, describe|transcribe, log}` so tests use recorders (repo convention); `index.ts` only subscribes.

### D9. Auth
Same gate as `add-service-control`: when `CONTROL_ENABLED=1` the three routes require the bearer token (401 otherwise); when control is not enabled they are unauthenticated, like today's `POST /control`. They can publish arbitrary-looking chat to the brain, which is why they sit under the same gate. `GET /uploads/:id` stays open (D2).

### D10. UI
"Test inputs" panel: textarea + viewer fields (user, platform select, mod, sub); image file input; audio file input; mic record button (optional, `MediaRecorder`, hidden if unavailable); level toggle (service/bus; bus disables image/audio pickers and exposes `as` for text); `remember` checkbox (default off, labelled "store in memory"); status line fed by `inject.result`. Feed rows with `data.injected` show an "injected" badge (and "remembered" when `remember`). When control is enabled the panel prompts for the token like the service controls do.

## Risks / Trade-offs

- Injected content is real to the brain: it can be spoken aloud on stream. Mitigated by gating, the badge, and `remember` default off; mute still works via `control`.
- Memory pollution via `brain.say` replies (D7); documented.
- Upload store is per dashboard process; a dashboard restart drops pending uploads (request then fails `ok:false`, fetch 404).
- Catalogue and `Control commands` are modified by sibling changes too: at archive, the catalogue list must be merged (`service.heartbeat`, `service.lifecycle`, `inject.request`, `inject.result`). This change's catalogue text includes all four so whichever archives last is correct; re-check on archive.

## Migration Plan

Additive. Old events lack the fields and behave as real. Compose: eyes and ears need `DASHBOARD_URL=http://dashboard:3000`; without it the default loopback URL fails in containers and injection returns `ok:false` with a clear detail.

## Open Questions

1. Tag `brain.say` replies caused by an injected event (e.g. propagate `injected` through `attention.focus`) so memory can skip them too? Needs a cortex/salience change; deferred.
2. Should bus-level image/audio allow the operator to type the description/transcript alongside the file? Currently use `/inject/text` `as: vision|speech`.
