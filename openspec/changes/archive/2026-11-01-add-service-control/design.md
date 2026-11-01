## Context

Services are independent containers/processes on one Redis stream `cohost:events`. Today nothing can start or stop them (launch is `docker compose up` or `pnpm dev`). The dashboard (`services/dashboard`, plain `node:http` + `ws`, routes in `routes.ts`) already fans out the bus and has an unauthenticated `POST /control`. Compose service names equal package names (`chat salience affect memory cortex voice avatar dashboard eyes ears` plus `redis postgres ollama tts stt`); each TS service has `dev` (`tsx watch src/index.ts`) and `start` (`node dist/index.js`) scripts and its own consumer group named after the service (memory also has `memory-recall`).

## Options considered (docs/plans/control-plane.md section 4)

| | A dashboard-embedded | B standalone CLI/TUI | C compose API wrapper container |
|---|---|---|---|
| One app, OBS/browser UI | yes | no | via dashboard |
| compose + `pnpm dev` | yes | yes | compose only |
| Privilege | high unless host-run/gated | lowest | high (docker.sock in a container) |
| New deployables | 0 | 1 | 1 |

Decision: **A, on a UI-agnostic core (`packages/control`)**. It meets the "one application" goal and works in OBS docks. Its weakness (privilege in the web process) is mitigated by gating: off by default, loopback bind, mandatory bearer token, manifest-only ids, fixed argv. B is kept as a final-phase second client (`cohostctl`) of the same core with no redesign. C rejected: compose-only (no `pnpm dev`), adds a socket-mounting container, and must supervise the stack it belongs to.

## Decisions

1. **Runtime interface**: `Runtime { start(id, opts), stop(id), restart(id, opts), status?(id) }` returning `{ok, detail?}`. Adapters:
   - `compose`: spawns `docker compose <up -d|stop|restart> <composeName>` via `execFile` (argv array, no shell). CLI first; Engine API deferred.
   - `process`: spawns `pnpm --filter @cohost/<id> dev|start` detached with fixed argv; keeps pid in memory; stop sends SIGTERM (services already exit via `onShutdown`), SIGKILL after a timeout. `dev` vs `start` chosen by `CONTROL_PROCESS_MODE` (default `dev`).
   - Selected by `CONTROL_RUNTIME` (default `compose`).
2. **Manifest-only**: ids are resolved against the registry manifest; anything else is 404 before any spawn. Argv is built from manifest fields only, never from request input.
3. **Resume vs fresh**: "fresh" runs `XGROUP SETID cohost:events <group> $` for each of the service's consumer groups AFTER the process is stopped and BEFORE it is started (and the group is created at `$` if missing). Defaults from the manifest: fresh for salience, affect, cortex, voice, avatar; resume for memory (groups `memory`, `memory-recall`). Request body `{mode?: "resume"|"fresh"}` overrides.
4. **Gating**: control routes exist only when `CONTROL_ENABLED=1`; startup fails fast if enabled without `CONTROL_TOKEN`. Bearer compare is constant-time. When enabled the server binds `127.0.0.1` unless `CONTROL_BIND` is set. When disabled, behaviour is exactly today's (binds as before, `/control` open).
5. **Self and infra**: the dashboard is marked `self`; stop/restart of it is rejected 409. `redis`/`postgres` are `infra`: listed read-only, mutations rejected 403 unless `CONTROL_ADVANCED=1`. Stopping redis would also silence the audit event, so an infra stop logs but cannot publish if the bus is down.
6. **Audit**: after every start/stop/restart attempt the dashboard publishes `service.lifecycle {service, action, by, ok, detail?}`. `by` is `"dashboard"` for HTTP callers (token identity is a single static secret; no per-user identity) or `"cohostctl"` for the CLI. Failures publish `ok:false` with `detail`.
7. **In-process pause/resume**: `control` gains optional `target` and cmds `pause`/`resume`. Services ignore events whose `target` is set and differs from their own name; undefined means all (back-compat). Paused cortex/salience/affect stop reacting (treated like muted for output, and event intake continues so context is not lost) without exiting. This lets the UI idle a service without touching the runtime.
8. **Host-run vs docker-socket**: recommended deployment runs the control-enabled dashboard on the host (`pnpm --filter @cohost/dashboard start`) so no socket mount is needed; the containerised dashboard stays monitor-only. Mounting `/var/run/docker.sock` into the dashboard container is a documented explicit opt-in with a root-equivalence warning; `process` runtime inside a container is unsupported.
9. **UI**: Services tab buttons Start/Stop/Restart (+ fresh/resume toggle); each prompts a confirmation; token stored in `sessionStorage` after a prompt, sent as `Authorization: Bearer`. Buttons hidden when `GET /services/control` reports disabled.
10. **Dependency on add-service-health**: registry and package scaffold come from that change; we only add runtime fields and the `Runtime` modules. Both specs touch `bus` "Known event catalogue"; whichever is archived second must merge the event list (heartbeat + lifecycle + control).

## Risks

- Token over plain HTTP on a non-loopback `CONTROL_BIND`: documented; recommend a reverse proxy/SSH tunnel. Mitigation: warn in log when bind is non-loopback.
- Orphaned `process`-runtime children if the dashboard dies: children are started detached; status falls back to heartbeat health (sibling change). Documented limitation.
- Restart races with consumer-group reset: reset only after the stop resolves.
