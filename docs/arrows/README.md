# `docs/arrows/` — Arrow of Intent Tracking

This directory tracks the arrow of intent across cohost — the chain from
high-level design through to realized code:

```
HLD → LLDs → EARS → Tests → Code
```

## Files in this directory

- **`index.yaml`** — The design tree and dependency graph. Load this first to
  understand what's available, what's blocked, and what needs work. cohost is
  flat (depth-2): every segment sits directly under the root HLD. The
  `taxonomy` block groups segments for navigation only (platform / senses /
  brain / body / operator).
- **`{segment-name}.md`** — One file per arrow segment. Orientation page with
  References, Spec Coverage, and Key Findings.

Design docs live in `docs/intent/{segment}/{segment}-design.md` with EARS specs
beside them in `{segment}-specs.md`. The root HLD is `docs/high-level-design.md`.

## Starting a session

1. Load `index.yaml`.
2. Query for unblocked segments:
   `yq '.arrows | to_entries | .[] | select(.value.blockedBy | length == 0) | .key' index.yaml`
3. Load the relevant `{segment-name}.md`.
4. Follow its References to the LLD, spec file, tests, or code.

## Status enum

| Status   | Meaning                                                   |
| -------- | --------------------------------------------------------- |
| UNMAPPED | Not yet explored                                          |
| MAPPED   | Structure known, specs not verified against code          |
| AUDITED  | Specs verified — implementation status understood         |
| OK       | Fully coherent — all specs implemented                    |
| PARTIAL  | Some specs missing or partial                             |
| BROKEN   | Code and docs have diverged significantly                 |
| STALE    | Docs exist but outdated                                   |
| OBSOLETE | Superseded, kept for historical reference                 |
| MERGED   | Combined into another arrow (see `merged_into`)           |

Normal progression: `UNMAPPED → MAPPED → AUDITED → OK`.

## Audit state

Each segment's `audited` date and `audited_sha` in `index.yaml` name the commit
its specs were last verified against; `next` summarises what is open. Intended
behaviour the code does not have is a `[ ]` line in the segment's EARS file;
behaviour deliberately postponed is `[D]`. LLD "Decisions & Alternatives" rows
marked `[inferred]` were read from the code and await the owner's
confirmation. Project-level decisions are in the HLD's Key Design Decisions
table.

## Common workflows

### Auditing a segment

1. Read the segment's arrow doc references.
2. For each EARS spec, verify the implementing code (add `@spec` annotations as
   you go).
3. Update the arrow doc coverage table and Key Findings.
4. Refresh `status`, `audited`, `audited_sha`, `next`, and `drift` in
   `index.yaml`.

### Mapping a new segment

1. Explore the code and docs for the domain.
2. Create `docs/arrows/{name}.md` from the arrow-doc template.
3. Create `docs/intent/{name}/{name}-design.md` and `{name}-specs.md`.
4. Add an entry to `index.yaml` under `arrows:` and to `taxonomy`.

### Splitting / merging / renaming

A segment's name is the prefix of its EARS IDs, so renames and re-parents
rewrite spec IDs, `@spec` annotations, the arrow-doc filename, the `index.yaml`
key, and every cross-reference in one session. See the arrow-maintenance skill.
