# Arrow: memory

Memory region: embeds what happened, answers recall and viewer-notes requests, keeps viewers and their fading notes, forgets removed chat, and consolidates into the personality file.

## Status

**PARTIAL**: 162 specs: 116 implemented, 0 deferred, 46 gaps. The gaps are chat safety (bounded rows, guarded capture, consolidation and reflection prompts) and, from the YouTube chat design of 2026-11-16 (no code yet), viewer identity by platform and user id (MEM-VIEWER-001, MEM-VIEWER-002, MEM-VIEWER-008 to MEM-VIEWER-011, MEM-SURF-001, MEM-SURF-002, MEM-SURF-004, MEM-SURF-006, MEM-SURF-007, MEM-VOICE-007, MEM-BACKEND-005), the platform, user id and message id kept on chat rows (MEM-WRITE-009, MEM-STORE-004) and forgetting removed chat (MEM-FORGET-001 to MEM-FORGET-007). Retention of YouTube viewers is an owner decision recorded in the LLD.

## References

### HLD
- docs/high-level-design.md (System Design, brain: memory)

### LLD
- docs/intent/memory/memory-design.md

### EARS
- docs/intent/memory/memory-specs.md (162 specs: 116 `[x]`, 46 `[ ]`, 0 `[D]`; prefix `MEM`; facet `FORGET` added for removed chat)

### Code and tests
- services/memory/src/ and services/memory/test/ (`@spec MEM-` annotations)

## Work Required

### Must Fix
- Viewer identity by platform and user id, the `memories` columns and forgetting a removed message (listed above).
- Chat safety specs not yet built.

### Nice to Have
None.
