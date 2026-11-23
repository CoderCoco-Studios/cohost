# Arrow: tools

The tool service: MCP servers over Streamable HTTP added from the dashboard, four built-in tools (stream info, memory lookup, clock, timers), the owner's per-tool marks, who can cause a call, per-call timeouts, the timer that comes due as a reminder for salience, and a mock mode.

## Status

**MAPPED**: designed and specified, not built. The LLD is written (2026-11-18) and `tools-specs.md` holds 108 specs, all `[ ]`. No code mentions MCP, tool calls or function calls.

## References

### HLD
- docs/high-level-design.md (System Design: Tool use; Key Design Decisions: Tool runtime; tenets 1, 3, 4, 6, 8, 13)

### LLD
- docs/intent/tools/tools-design.md

### EARS
- docs/intent/tools/tools-specs.md (108 specs, prefix `TOOL`: 0 `[x]`, 108 `[ ]`, 0 `[D]`)

### Code and tests
- services/tools/ (to be built)

## Work Required

### Must Fix
- Build the service and the cascades below; each segment's own specs carry the lines: cortex (the tool loop, the filler, the `reminder` focus, the prompt, stamps), event-bus (four event types, `focus.kind` `reminder`, `inject.request` target `tools`, `cut` `vetoed`, two `Timing` members), config (the `tools` section, the wildcard secret path, egress entries, the isolation override, presentation), dashboard (the Tools settings, feed rows, the tool test injection), salience (reminders), module-contract, control-plane (the twelfth application service and the twentieth unit, the latency `tool` stage), deployment (the `tools` service and the `jobs` profile), shared-runtime (`untrustedToolNotice`, `parseVideoValue`), chat, memory.

### Nice to Have
None.
