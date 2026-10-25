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
