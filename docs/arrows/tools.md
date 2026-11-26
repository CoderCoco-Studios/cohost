# Arrow: tools

The tool service: MCP servers over Streamable HTTP added from the dashboard, four built-in tools (stream info, memory lookup, clock, timers), the owner's per-tool marks, who can cause a call, per-call timeouts, the timer that comes due as a reminder for salience, and a mock mode.

## Status

**PARTIAL**: the `tools` service is built (`services/tools`): catalog, call pipeline, confirmation, mock mode and test injection. `tools-specs.md` holds 141 specs: 141 `[x]`, 0 `[ ]` (TOOL-SVC-012, the logger with no file, is built, #349; TOOL-SVC-010, the unit's `secrets` list, #318, and TOOL-SVC-011, a URL its network cannot reach, #319, are built). The MCP client (`services/tools/src/mcp.ts`, #206) is built and tested against in-process fake servers; no real MCP server has been run against the service. The four built-in tools (`services/tools/src/builtin/`, #207) are built and tested with injected clocks, a scripted `fetch` and a fake bus; no live Twitch, YouTube or memory run has been made.

The `tools` unit is in the control-plane manifest (twelve application services), in `docker-compose.yml` (no profile, least privilege: DEPLOY-COMPOSE-026) and in the root `tsconfig.json` (#208). The `as: "tool"` injection route is #211, so the tools text input is not yet accepted by `POST /inject/text`.

## References

### HLD
- docs/high-level-design.md (System Design: Tool use; Key Design Decisions: Tool runtime; tenets 1, 3, 4, 6, 8, 13)

### LLD
- docs/intent/tools/tools-design.md

### EARS
- docs/intent/tools/tools-specs.md (141 specs, prefix `TOOL`: 141 `[x]`, 0 `[ ]`, 0 `[D]`)

### Code and tests
- services/tools/src/ (catalog.ts, calls.ts, mcp.ts, mock.ts, health.ts, main.ts, source.ts, builtin/); tests under services/tools/test/ (mcp-session, mcp-auth, mcp-calls, with mcp-server.ts as the fake server; builtin-clock, builtin-stream, builtin-memory, builtin-timer, builtin-catalog, with builtin-helpers.ts)

## Work Required

### Must Fix
- Build the service and the cascades below; each segment's own specs carry the lines: cortex (the tool loop, the filler, the `reminder` focus, the prompt, stamps), event-bus (four event types, `focus.kind` `reminder`, `inject.request` target `tools`, `cut` `vetoed`, two `Timing` members), config (the `tools` section, the wildcard secret path, egress entries, the isolation override, presentation), dashboard (the Tools settings, feed rows, the tool test injection), salience (reminders), module-contract, control-plane (the twelfth application service and the twentieth unit, the latency `tool` stage), deployment (the `tools` service, which has no profile), shared-runtime (`untrustedToolNotice`, `parseVideoValue`), chat, memory.

### Nice to Have
None.
