# Arrow: memory

Memory region: embeds what happened, answers recall and viewer-notes requests, keeps viewers and their fading notes, forgets removed chat, and consolidates into the personality file.

## Status

**PARTIAL**: 173 specs: 159 implemented, 0 deferred, 14 gaps. Viewer identity by platform and user id (viewerKey), chat ids on rows and forgetting removed chat are implemented in the in-memory store and the region; the Postgres side (MEM-STORE-004, the `memories` columns and indexes, and the `chat` row and forget SQL in both stores) is written but unproven locally, because the Postgres tests skip without COHOST_TEST_DATABASE_URL. Existing dev `memories` tables without the new columns must be recreated. Open gaps: the streamed-speech clause writes (MEM-WRITE-010 to MEM-WRITE-019), MEM-STORE-004, and three pre-existing gaps (MEM-EVT-001, MEM-WRITE-003, MEM-RECALL-007). Retention of YouTube viewers is an owner decision recorded in the LLD.

## References

### HLD
- docs/high-level-design.md (System Design, brain: memory)

### LLD
- docs/intent/memory/memory-design.md

### EARS
- docs/intent/memory/memory-specs.md (173 specs: 159 `[x]`, 14 `[ ]`, 0 `[D]`; prefix `MEM`; facet `FORGET` added for removed chat)

### Choices
- Chat lines have `«` and `»` replaced with straight quotes before bounding, so no hook payload carries those marks (MEM-CAPTURE-020). Speech lines are not changed.
- Viewers are keyed by the shared `viewerKey` (SHARED-GUARD-025..027), never case-folded by id. Voice rows (`discord:<speakerId>`) are a separate namespace read by the voice rules; owner placeholders (MEM-REG-003) stay readable until claimed (MEM-VIEWER-011 readings, recorded in the LLD).
- No Postgres migration: pre-alpha, so an existing dev `memories` table must be recreated to gain the chat columns.

### Code and tests
- services/memory/src/ and services/memory/test/ (`@spec MEM-` annotations)

## Work Required

### Must Fix
- Verify MEM-STORE-004 and the Postgres `chat` row and forget SQL against a live database (COHOST_TEST_DATABASE_URL).

### Nice to Have
None.
