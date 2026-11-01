## Why

The owner wants to exercise the brain and the perception services without a live stream: type a fake viewer message, drop in a screenshot, upload a spoken clip, and watch the real pipeline react. Today the only operator input is `POST /control` (`say`, mute, ...), which skips perception and the brain entirely. Bus-level injection (publishing `chat.message` / `speech.heard` / `vision.summary` directly) tests the brain with eyes/ears off; service-level injection (eyes describes an uploaded image, ears transcribes an uploaded clip, chat publishes as a viewer) also tests the real perception code. Both are needed. Part of the control plane in `docs/plans/control-plane.md`; siblings `add-service-health`, `add-service-control`, `add-isolated-backends`.

## What Changes

- Dashboard gains `POST /inject/text` (JSON), `POST /inject/image` and `POST /inject/audio` (raw body + `Content-Type`, options in the query string), each taking `level` (`service` | `bus`) and `remember` (default false). A bounded in-memory upload store (size cap, per-entry TTL, entry cap) serves uploads at `GET /uploads/:id`; binaries never go on the Redis stream.
- Bus: new `inject.request` `{id, target: "eyes"|"ears"|"chat", kind: "image"|"audio"|"text", url?, text?, meta?: {user?, platform?, isMod?, isSub?}, remember}` and `inject.result` `{id, ok, detail?}`. `chat.message`, `speech.heard`, `vision.summary` gain optional `injected` and `remember` (absent = a real event).
- chat, eyes, ears each subscribe (own consumer group, type `inject.request`) and, for their target, produce the normal perception event with `injected: true` (and `remember`), then publish `inject.result`. Handled even when the live source is off/fake.
- memory stores injected events only when `remember` is true; `viewers` are not touched for non-remembered injected chat. Salience, affect and cortex treat injected events as real (no change).
- Dashboard feed shows an "injected" badge; new "Test inputs" panel (text with viewer fields, image picker, audio picker, optional mic record, level toggle, remember toggle, status line).
- `@cohost/config` `urls` gains `dashboard()` (env `DASHBOARD_URL`) so eyes/ears can fetch uploads.

## Capabilities affected

- `bus` (modified: catalogue + three payloads; added: injection events), `dashboard` (added: inject routes, upload store, test-inputs panel, injected badge), `chat`, `eyes`, `ears` (each added: inject handling), `memory` (modified: Storing memories; added: viewer tracking for injected chat), `salience` (added: flag propagation), `cortex` (added: flag propagation), `working-memory` (added: events retain flags).
- No spec change for affect, voice, avatar.

## Bus events changed

- ADDED `inject.request`, `inject.result` (on `cohost:events`).
- MODIFIED `chat.message`, `speech.heard`, `vision.summary`, `brain.say`, `attention.focus`: optional `injected?: boolean`, `remember?: boolean`. (Cortex answers only via `attention.focus`, so it carries them from salience to cortex.) Back-compat: existing producers and consumers are unchanged.

## Dependencies on sibling changes

- `add-service-control`: the bearer-token gate (`CONTROL_ENABLED`, `CONTROL_TOKEN`) is reused as-is for the three inject routes; this change defines no auth of its own. If it has not landed, the inject routes are unauthenticated, exactly like today's `POST /control`. The `bus` catalogue and `Control commands` requirements are also modified there; see design for archive-order reconciliation.
- `add-isolated-backends`: `chat.source: fake`, `vision.enabled=false`, `ears.source: off` keep the services running idle; injection handlers must be wired regardless of those sources. Mock LLM + in-memory (`memory`) store make bus-level injection usable with nothing else running.
- `add-service-health`: optional. Heartbeat `deps` can show why an inject failed; `inject.result` does not depend on it. Heartbeats stay on `cohost:health`; `inject.*` stay on `cohost:events`.

## Out of scope

- Load/stress testing, recording and replaying sessions, injecting `brain.say` / `voice.utterance` (already `control say`), auth beyond the shared bearer token, persistent upload storage, video input.
