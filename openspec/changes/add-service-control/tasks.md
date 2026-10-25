## 1. Bus events
- [x] 1.1 In `packages/bus/src/events.ts` add `service.lifecycle` schema `{service, action: enum start|stop|restart, by, ok, detail?}`; register in `EventPayloads`/`EVENT_TYPES`
- [x] 1.2 Extend `control` schema: `cmd` adds `pause`,`resume`; add `target: z.string().optional()`
- [x] 1.3 Tests in `packages/bus/test`: lifecycle validation, control without target still valid, target accepted, invalid action rejected

## 2. Runtime core (packages/control; requires add-service-health scaffold)
- [x] 2.1 Extend registry manifest with `composeName`, `pnpmFilter`, `groups[]`, `defaultMode`, `infra`, `self`; test every manifest id has these
- [x] 2.2 Define `Runtime` interface and result type
- [x] 2.3 `process` adapter: fixed-argv spawn, pid tracking, SIGTERM then SIGKILL timeout; tests with an injected spawner
- [x] 2.4 `compose` adapter: `execFile docker compose up -d|stop|restart <name>`; tests assert exact argv and no shell
- [x] 2.5 Consumer-group reset helper (`XGROUP SETID <group> $`, create if missing) and fresh/resume orchestration (stop, reset, start); tests with fake redis
- [x] 2.6 `ServiceController` applying guards: unknown id, `self`, `infra` unless advanced; tests for each rejection

## 3. Dashboard routes and gating
- [x] 3.1 Config parsing for `CONTROL_ENABLED`, `CONTROL_TOKEN`, `CONTROL_BIND`, `CONTROL_RUNTIME`, `CONTROL_ADVANCED`; fail fast if enabled without token
- [x] 3.2 Bearer middleware (constant-time compare); apply to `POST /control`, `PUT /personality` and service routes only when enabled
- [x] 3.3 Routes `POST /services/:id/start|stop|restart` (+ `GET /services/control` flag); publish `service.lifecycle` after each attempt
- [x] 3.4 Bind loopback by default when enabled, honour `CONTROL_BIND`, warn on non-loopback
- [x] 3.5 Tests in `services/dashboard/test`: disabled (404 + `/control` open), enabled 401/204, unknown id 404, self 409, infra 403, audit event published, bind selection

## 4. In-process pause/resume
- [ ] 4.1 salience: honour `pause`/`resume` and `target`; test
- [ ] 4.2 affect: same; test
- [ ] 4.3 cortex: same (no LLM calls while paused); test
- [x] 4.4 Dashboard `POST /control` accepts `pause`/`resume`/`target`

## 5. UI
- [ ] 5.1 Services tab controls with Start/Stop/Restart, fresh/resume toggle, confirm dialog, token prompt
- [ ] 5.2 Show `service.lifecycle` events in the feed; hide controls when control disabled

## 6. Docs and CLI
- [ ] 6.1 README ops section: enabling control, host-run recommendation, docker-socket opt-in warning
- [ ] 6.2 Optional `cohostctl` CLI (status/start/stop/restart) on `packages/control`, publishing `by: "cohostctl"`; tests for argument parsing
- [ ] 6.3 Run `pnpm test`; update `openspec/specs` on archive
