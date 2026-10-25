# Spec-driven development

cohost uses [OpenSpec](https://github.com/Fission-AI/OpenSpec)
(`@fission-ai/openspec`, pinned to 1.15.0 when this was set up) so that
behavior is agreed on in writing before code changes, and `openspec/specs/`
always describes what the system does today.

## Why OpenSpec (and not spec-kit)

| | OpenSpec | GitHub spec-kit |
| --- | --- | --- |
| Fit for existing code | Built for brownfield: baseline specs live in `openspec/specs/`, changes are *deltas* against them | Greenfield-oriented; each feature gets a fresh spec/plan/tasks folder, no living source of truth |
| Footprint | `openspec/` dir + generated Claude commands/skills; Node CLI via npx | Python CLI (`specify`) plus templates and scripts that create branches itself |
| Branch/worktree handling | None — leaves git to us | Creates its own feature branches, which clashes with the Pane-worktree workflow |
| Archive step | Merges deltas into the main specs | No equivalent |

Chosen: OpenSpec. The repo already exists with ten services and six packages,
so a living baseline plus delta-based changes matters more than a heavyweight
per-feature template, and it does not fight the worktree-per-task workflow.

## Layout

```
openspec/
  config.yaml        project context + per-artifact rules (read by every /opsx command)
  specs/<capability>/spec.md   current behavior, one dir per package/service
  changes/<name>/    in-flight changes: proposal.md, design.md, tasks.md, specs/ (deltas)
  changes/archive/   finished changes
.claude/commands/opsx/   generated slash commands
.claude/skills/openspec-*/   generated skills
```

Capabilities: `bus`, `config`, `modules`, `llm`, `working-memory`, `affect`,
`avatar`, `chat`, `cortex`, `dashboard`, `ears`, `eyes`, `memory`, `salience`,
`voice`.

## The flow: propose → apply → archive

1. **Propose** — `/opsx:propose "add a /shush reflex to salience"`
   Creates `openspec/changes/<name>/` with the proposal, spec deltas
   (`## ADDED|MODIFIED|REMOVED Requirements`), design, and tasks. Planning only;
   review and edit these files, then approve.
2. **Apply** — `/opsx:apply`
   Implements `tasks.md` in order and ticks each box. Do this in a Pane
   worktree/branch, never on `main`. Run `pnpm test` before finishing.
3. **Archive** — `/opsx:archive`
   After the implementing PR merges, merges the deltas into `openspec/specs/`
   and moves the change to `changes/archive/`.

Other useful commands: `/opsx:explore` (think before proposing),
`/opsx:continue` and `/opsx:ff` (step through / fast-forward artifact
creation), `/opsx:verify` (check implementation matches the specs),
`/opsx:sync`, `/opsx:bulk-archive`.

## When a spec is required

| Change | Spec? |
| --- | --- |
| New service, event type, config key, or behavior change visible on the bus | Yes — propose first |
| Changing a payload shape in `packages/bus/src/events.ts` | Yes — touches `bus` plus every producer/consumer spec |
| Bug fix that restores documented behavior | No; add a test. If the spec was wrong, fix it via a change |
| Refactor with no observable change, docs, tooling | No |

## Writing specs

- One `### Requirement:` per behavior, phrased with SHALL/MUST.
- Every requirement has at least one `#### Scenario:` using
  **WHEN** / **THEN** bullets (exactly four `#` on scenarios).
- Describe the contract (events in/out, payloads, defaults, edge cases), not
  internals. Name real event types and config keys.
- In a change, deltas go in `changes/<name>/specs/<capability>/spec.md` under
  `## ADDED Requirements`, `## MODIFIED Requirements` (restate the whole
  requirement), or `## REMOVED Requirements`.

## CLI cheatsheet

```bash
npx @fission-ai/openspec list --specs        # capabilities
npx @fission-ai/openspec list                # active changes
npx @fission-ai/openspec show <name>         # view a spec or change
npx @fission-ai/openspec validate --all --strict
npx @fission-ai/openspec update              # regenerate .claude/ after a CLI upgrade
```

Run `validate --all --strict` before opening a PR that touches `openspec/`.

## Upgrading

Check the registry (`npm view @fission-ai/openspec version`), bump the version
you invoke, then run `openspec update` and commit the regenerated `.claude/`
files. Node >=20.19 is required by the CLI.
