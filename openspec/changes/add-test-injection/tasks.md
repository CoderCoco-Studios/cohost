## 1. Bus events
- [x] 1.1 In `packages/bus/src/events.ts` add optional `injected: z.boolean().optional()` and `remember: z.boolean().optional()` to `chat.message`, `vision.summary`, `speech.heard` (no defaults); same two optional fields on `brain.say` and `attention.focus`
- [x] 1.2 Add `inject.request` and `inject.result` schemas; register in `EventPayloads`/`EVENT_TYPES`
- [x] 1.3 Tests in `packages/bus/test`: old payloads still valid and unchanged, flags accepted on `brain.say`/`attention.focus`, request enum validation, result validation

## 2. Config
- [x] 2.1 Add `urls.dashboard()` (`DASHBOARD_URL`, default `http://127.0.0.1:3000`) to `packages/config/src/index.ts`; test default and override
- [x] 2.2 Set `DASHBOARD_URL=http://dashboard:3000` for eyes and ears in `docker-compose.yml`

## 3. Dashboard routes and upload store
- [x] 3.1 `services/dashboard/src/uploads.ts`: in-memory store with per-kind size caps, TTL, entry/total caps, random 128-bit ids; env `INJECT_MAX_IMAGE_BYTES`, `INJECT_MAX_AUDIO_BYTES`, `INJECT_TTL_MS`
- [x] 3.2 `GET /uploads/:id` (content-type from upload, 404 unknown/expired)
- [x] 3.3 `POST /inject/text` (service chat, bus chat/speech/vision), validation and 400s
- [x] 3.4 `POST /inject/image` and `/inject/audio` (raw body, query options, 413/415/400, 202 `{id}`, publish `inject.request` with `${urls.dashboard()}/uploads/<id>`)
- [x] 3.5 Apply the `add-service-control` bearer gate to the three inject routes when enabled (reuse its middleware; 401 otherwise)
- [x] 3.6 Tests in `services/dashboard/test/inject.test.ts` and `uploads.test.ts`: each route and level, emitted payloads (`injected`, `remember`, `source`), size/type rejection, TTL expiry and eviction, 404 on expired, gate on/off

## 4. chat
- [x] 4.1 `services/chat/src/inject.ts` handler (text -> `chat.message` injected, defaults, mention detection, blank text, bypass ignore rules); `inject.result`
- [x] 4.2 In `services/chat/src/index.ts` subscribe group `chat` type `inject.request`, independent of `chat.source`; drop stale (>60 s) requests
- [x] 4.3 Tests in `services/chat/test`

## 5. eyes
- [ ] 5.1 `services/eyes/src/inject.ts` (fetch guarded to dashboard uploads URL, base64, `describe(b64,"")`, publish injected `vision.summary`, `inject.result`; does not touch `previous`)
- [ ] 5.2 Subscribe group `eyes` in `index.ts`, working when `vision.enabled=false`
- [ ] 5.3 Tests in `services/eyes/test`: success, SAME/empty, model failure, foreign URL rejected, disabled vision

## 6. ears
- [ ] 6.1 `services/ears/src/inject.ts` (guarded fetch, STT via `sttTranscriber`, WAV duration, publish injected `speech.heard`, `inject.result`)
- [ ] 6.2 Subscribe group `ears` in `index.ts`, working when `ears.source=off`
- [ ] 6.3 Tests in `services/ears/test`: success, empty transcript, STT failure, foreign URL, non-WAV duration 0

## 7. memory
- [ ] 7.1 In `createMemoryHandler` skip viewer touch, `memory.viewer` and `remember` for `injected && !remember`; store normally when `remember` true
- [ ] 7.2 Tests in `services/memory/test`: injected unremembered chat/speech, injected remembered, real event with stray `remember:false`

## 7b. Flag propagation (cortex, salience, working-memory)
- [ ] 7b.1 `packages/working-memory`: `ContextEvent` chat/speech/vision keep `injected`/`remember` from the bus event; test in `packages/working-memory/test`
- [ ] 7b.2 salience: `attention.focus` carries `injected`/`remember` of the focus event (absent when no focus or real); reflex `brain.say` copies them from the triggering event; tests in `services/salience/test`
- [ ] 7b.3 cortex: `think(focus)` passes `focus.injected`/`remember` to `say()` so the `brain.say` carries them; `control say` stays unflagged; tests in `services/cortex/test`
- [ ] 7b.4 memory: skip `brain.say` as `self` memory when `injected` and not `remember`; test in `services/memory/test`

## 8. UI
- [ ] 8.1 Injected/remembered badge on feed rows
- [ ] 8.2 "Test inputs" panel (text + viewer fields, image/audio pickers, level and remember toggles, token prompt when control enabled, status line from `inject.result`, 10 s no-response message)
- [ ] 8.3 Optional: mic recording via `MediaRecorder` (hidden when unsupported)

## 9. Verify
- [ ] 9.1 `pnpm test` green; manual: inject each kind at both levels with eyes/ears in isolated mode
