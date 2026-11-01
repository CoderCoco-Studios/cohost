# cohost

Locally hosted AI VTuber co-host: pnpm TypeScript monorepo, services on a Redis
Streams bus. See `README.md` for architecture and `openspec/config.yaml` for
the stack/conventions summary.

## Commands

- `pnpm build` / `pnpm typecheck` — `tsc -b`
- `pnpm test` — build then run all `test/*.test.ts` with node:test + tsx
- `pnpm test:only` — skip the build

## Spec-driven development (OpenSpec)

Behavior is specified in `openspec/specs/<capability>/spec.md` (one per
package/service). Changes go through propose → apply → archive. Full guide:
`docs/SPEC-DRIVEN.md`.

1. `/opsx:propose "<idea>"` — creates `openspec/changes/<name>/` (proposal,
   spec deltas, design, tasks). Planning only; get the artifacts reviewed
   before coding.
2. `/opsx:apply` — implement `tasks.md`, ticking tasks as you go, in a
   worktree/branch (never `main`). Run `pnpm test`.
3. `/opsx:archive` — after the PR merges, merge the deltas into
   `openspec/specs/` and archive the change.

Rules:
- New/changed bus events, payload shapes, config keys, or service behavior need
  a change first. Bug fixes, refactors, and docs do not.
- Event changes in `packages/bus/src/events.ts` must update the `bus` spec and
  each producer/consumer service spec.
- Don't hand-edit `openspec/specs/` for new behavior; use a change's deltas.
  Fixing a spec that is simply wrong is fine.
- Run `npx @fission-ai/openspec validate --all --strict` before a PR touching
  `openspec/`.
- `.claude/commands/opsx/` and `.claude/skills/openspec-*` are generated; change
  them via `openspec update`, not by hand.

## LID
- Mode: Full
- Version: 1.4.2

## Linked-Intent Development (MANDATORY)

**Consult the `linked-intent-dev` skill for ALL code changes.** All changes flow through the arrow of intent in one direction:

```
HLD → LLDs → EARS → Tests → Code
```

- **All changes**: consult the `linked-intent-dev` skill if your harness provides it; otherwise read `docs/lid/workflow.md` before making changes, and if it is missing and `## LID` records no decline, offer the user once to add it from https://raw.githubusercontent.com/jszmajda/lid/v1.4.2/plugins/linked-intent-dev/skills/update-lid/references/workflow-doc.md (on decline, add `- Workflow doc: declined` to `## LID`). The workflow in one line: HLD check → LLD → EARS specs → edge audit → failing tests first → code — inspected at each phase.
- **Bug fixes**: walk the arrow like any other change — find where behavior diverged from intent and cascade from there. No short-circuit.

Each phase's output is inspected — by the user or an inspector they name — before the next begins; ambiguous spec readings go back to the user. **Docs carry current intent, written to be read cold** — write each doc as if authored fresh today, from current intent alone: no narration of how it changed, no meaning that needs the conversation that produced it, no rebuttals to questions only a past discussion raised. Rationale, considered alternatives, and constraints a fresh author would independently write stay; record rejected alternatives and why in the LLD's Decisions & Alternatives table, not as asides in body prose.

**Memory vs. intent.** Before saving durable project knowledge to agent or tool memory, test whether it is project *intent* — would a fresh agent, in any tool, next session, need it to build this system correctly? If yes, record it in the arrow (HLD / LLD / EARS / decision doc), which travels and cascades — not in private, per-tool memory, where intent escapes the arrow. Knowledge about the user or how they like to work stays in memory.

### Navigation

| What you need | Where to look |
|---|---|
| High-level design | `docs/high-level-design.md` |
| Design tree (sub-HLDs, LLDs, their specs) | `docs/intent/` — one folder per node |
| EARS specs | beside each design doc as `{node}-specs.md` in the node's folder under `docs/intent/` |
| Decision docs | `docs/decisions/` (project-level) and `docs/intent/<segment>/decisions/` |
| Arrow of intent overlay | `docs/arrows/index.yaml` and per-segment docs in `docs/arrows/` |

### Terminology

- **HLD**: High-Level Design — single project-level doc at `docs/high-level-design.md`.
- **LLD**: Low-Level Design — detailed component design doc in `docs/intent/`. The design layer is a recursive tree: the root is the HLD, leaf LLDs own EARS, and a component deep enough to outgrow one doc becomes a sub-HLD (HLD-shaped, owns no EARS) with children beneath it. "HLD" and "LLD" are roles by position; depth-2 (one HLD over flat leaf LLDs) is the default.
- **EARS**: Easy Approach to Requirements Syntax — structured one-line requirements beside each design doc as `{node}-specs.md` in the node's folder under `docs/intent/`. IDs are path-concatenated — the root-to-leaf path of the owning segment plus a number — so a prefix grep gathers a subtree. Markers: `[x]` implemented, `[ ]` active gap, `[D]` deferred.
- **Arrow**: the unidirectional chain from vision to code (HLD → LLDs → EARS → Tests → Code). Strictly a DAG of intent.
- **Arrow segment**: the territory owned by one leaf LLD — the LLD itself plus the specs, tests, and code that cite its EARS IDs. The boundary is the leaf prefix. Within-segment cascade is free; across-segment cascade pauses.
- **Cascade**: propagating a change downstream through the arrow so adjacent levels stay coherent.

### Code annotations

Annotate code and tests with `@spec` comments citing EARS IDs:

```
// @spec AUTH-UI-001, AUTH-UI-002
```

Place the annotation at the *entry point of the behavior's implementation graph* — the topmost function or module owning the specified behavior, not every helper. When a behavior spans multiple subsystems (UI + API + database, for example), annotate at the entry point in each subsystem. Tests follow the same rule: annotate the test that directly exercises the spec, not every inner assertion.
