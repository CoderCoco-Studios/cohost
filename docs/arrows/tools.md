# Arrow: tools

The tool service: MCP servers over Streamable HTTP added from the dashboard, four built-in tools (stream info, memory lookup, clock, timers), the owner's per-tool marks, who can cause a call, per-call timeouts, the timer that comes due as a reminder for salience, and a mock mode.

## Status

**PARTIAL**: the `tools` service is built (`services/tools`): catalog, call pipeline, confirmation, mock mode and test injection. `tools-specs.md` holds 112 specs: 65 `[x]`, 47 `[ ]`. The MCP client (#206) and the built-in tools (#207) are not built yet; no live MCP server has been run against the service.

`tools` has no Compose service or manifest unit yet: #208 adds them. Until then `packages/config/test/compose-standalone.test.ts` exempts it by name (`UNCOMPOSED_UNTIL_208`), and #208 removes that exemption.

## References

### HLD
- docs/high-level-design.md (System Design: Tool use; Key Design Decisions: Tool runtime; tenets 1, 3, 4, 6, 8, 13)

### LLD
- docs/intent/tools/tools-design.md

### EARS
- docs/intent/tools/tools-specs.md (112 specs, prefix `TOOL`: 65 `[x]`, 47 `[ ]`, 0 `[D]`)

### Code and tests
- services/tools/src/ (catalog.ts, calls.ts, mock.ts, health.ts, main.ts, source.ts); tests under services/tools/test/

## Work Required

### Must Fix
- Build the service and the cascades below; each segment's own specs carry the lines: cortex (the tool loop, the filler, the `reminder` focus, the prompt, stamps), event-bus (four event types, `focus.kind` `reminder`, `inject.request` target `tools`, `cut` `vetoed`, two `Timing` members), config (the `tools` section, the wildcard secret path, egress entries, the isolation override, presentation), dashboard (the Tools settings, feed rows, the tool test injection), salience (reminders), module-contract, control-plane (the twelfth application service and the twentieth unit, the latency `tool` stage), deployment (the `tools` service and the `tools` profile), shared-runtime (`untrustedToolNotice`, `parseVideoValue`), chat, memory.

### Nice to Have
None.
