---
title: How specs work
description: Linked-intent development as this project uses it, from design to tests to code.
track: project
verified: f126b949cf41b503f28c7935d3c8522bb7b659d6
---

# Spec-driven development

cohost uses **linked-intent development (LID)**: behavior is agreed on in
writing before code changes, and the design docs always describe what the
system does today. The LID plugin (`linked-intent-dev` and
`arrow-maintenance`, v1.4.2) drives the workflow from Claude Code.

## The arrow of intent

Every change flows in one direction:

```
HLD → LLDs → EARS → Tests → Code
```

| Layer | Where | What it holds |
| --- | --- | --- |
| HLD | `docs/high-level-design.md` | Problem, goals, tenets, system design, cross-cutting protocols |
| LLD | `docs/intent/<segment>/<segment>-design.md` | How one segment works, its decisions and open questions |
| EARS | `docs/intent/<segment>/<segment>-specs.md` | One line per behavior, `PFX-FACET-NNN`, marked `[x]` done / `[ ]` gap / `[D]` deferred |
| Arrow overlay | `docs/arrows/index.yaml` + `docs/arrows/<segment>.md` | Status, dependencies, drift and work required per segment |
| Code | `@spec PFX-FACET-NNN` comments | Links code and tests back to the spec line |

Segments (flat): `config`, `event-bus`, `model-backends`, `region-hooks`, `connections`,
`working-memory`, `shared-runtime`, `control-plane`, `chat`, `eyes`, `ears`,
`salience`, `affect`, `memory`, `cortex`, `tools`, `voice`, `mouth`, `avatar`,
`dashboard`, `deployment`, `module-contract`, `docs-site`.
Start at `docs/arrows/index.yaml`; `blockedBy` gives the dependency order.
The `@cohost/shared` package is the `shared-runtime` segment.

## The flow

1. **Orient** — read `docs/arrows/index.yaml`, then the arrow doc and LLD for
   the segment you are changing.
2. **Design** — `/linked-intent-dev` walks the change top-down: HLD (only if
   intent changes), LLD, EARS spec lines, an edge audit, then tests, then
   code. Each phase stops for review before the next.
3. **Implement** — in a worktree/branch, never on `main`. Annotate code and
   tests with `@spec <ID>`. Run `mise run test`.
4. **Reconcile** — flip the EARS markers you implemented to `[x]` and update
   the arrow doc. `/arrow-maintenance` audits spec-to-code coherence and flags
   drift or orphans.

## When a spec is required

| Change | Spec? |
| --- | --- |
| New service, [event](../start/glossary.md#event) type, config key, or behavior visible on the [bus](../start/glossary.md#bus) | Yes: LLD + EARS lines first |
| Changing a payload shape in `packages/bus/src/events.ts` | Yes: `event-bus` plus every producer/consumer segment |
| Bug fix that restores documented behavior | Walk the arrow anyway (find the EARS line, add a test); no new design |
| Refactor with no observable change, docs, tooling | No |

## Writing EARS specs

- One line per behavior using the five EARS patterns: ubiquitous, *When*,
  *While*, *Where*, *If-then*.
- Name the scope in the clause so a line reads correctly when found by grep.
- IDs are `PFX-FACET-NNN`, zero-padded, no gaps within a facet. Prefixes are
  declared in each design doc's frontmatter.
- Describe the contract (events in/out, payloads, defaults, edge cases), not
  internals.
