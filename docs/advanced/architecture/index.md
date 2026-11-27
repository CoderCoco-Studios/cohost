---
title: Reading the design
description: How cohost's design record is organised, how to read an excerpt page, and how each segment maps onto the code.
track: advanced
---

# Reading the design

cohost is built from a written design before it is built from code. This section of the site shows the interesting part of that record: why the system is shaped the way it is. This page explains how the record is organised and how to find your way from an idea to the code that implements it.

## What you are reading

The pages beneath this one are excerpts of the design documents, shown as written. They are not held to the wording and glossary-link rules of the rest of the site, so they use the design's own working vocabulary, cite specification IDs and link to files that are not part of the site. Where a design document links to another file, the excerpt links to that file on GitHub. When a term is unfamiliar, the [glossary](../../start/glossary.md) defines every term the rest of the site uses.

Each excerpt opens with a line naming its source file and linking it on GitHub, where the full document lives.

## How the design record is organised

The design flows in one direction, from the vision to the code:

| Layer | What it holds | Where it is |
| --- | --- | --- |
| High-level design | The problem, the approach, the tenets, the system design and the key decisions | `docs/high-level-design.md` |
| Low-level designs | One document per segment: what it owns, how it works and the alternatives considered | `docs/intent/<segment>/<segment>-design.md` |
| Specs | One-line requirements in a fixed sentence pattern, each with an ID, marked as implemented, a gap or deferred | `docs/intent/<segment>/<segment>-specs.md` |
| Tests | Tests that cite the spec IDs they exercise | `packages/*/test` and `services/*/test` |
| Code | Code annotated with the same IDs at the entry point of each behaviour | `packages/*`, `services/*` and `crates/*` |

A change starts at the top and flows down, with each layer checked before the next. [How specs work](../../project/spec-driven.md) describes the method, and `mise run lid-check` confirms that every ID cited in code and tests exists. Because the layers cite each other by ID, you can start from a behaviour you see in the code and find the sentence that requires it, or start from a requirement and find the tests and code.

## The design pages

The Design pages are the five sections of the high-level design:

| Page | What it answers |
| --- | --- |
| [Problem](design/problem) | The problem cohost sets out to solve |
| [Approach](design/approach) | The shape of the solution |
| [Tenets](design/tenets) | Tests a reviewer can apply to a design or a pull request |
| [System design](design/system-design) | The services, the [bus](../../start/glossary.md#bus) and how they fit together |
| [Key decisions](design/key-decisions) | The decisions that shaped the rest of the design |

## Segments

A segment is the territory of one low-level design: the design, its specs, and the tests and code that cite them. The Segments pages hold each design's context and philosophy, grouped as the high-level design groups them. The service names below are the `services/` folders and `packages/` that hold each segment's code.

| Group | Segment | Where its code lives |
| --- | --- | --- |
| Platform | [event-bus](segments/event-bus) | `packages/bus`, `crates/cohost-bus`, `crates/cohost-bus-node` |
| Platform | [config](segments/config) | `packages/config` |
| Platform | [model-backends](segments/model-backends) | `packages/llm` |
| Platform | [region-hooks](segments/region-hooks) | `packages/modules` |
| Platform | [working-memory](segments/working-memory) | `packages/working-memory` |
| Platform | [connections](segments/connections) | `packages/bus` (the [connector](../../start/glossary.md#connector) protocol), `services/connector-discord` |
| Platform | [shared-runtime](segments/shared-runtime) | `packages/shared` |
| Senses | [chat](segments/chat) | `services/chat` |
| Senses | [eyes](segments/eyes) | `services/eyes` |
| Senses | [ears](segments/ears) | `services/ears` |
| Brain | [salience](segments/salience) | `services/salience` |
| Brain | [affect](segments/affect) | `services/affect` |
| Brain | [memory](segments/memory) | `services/memory` |
| Brain | [cortex](segments/cortex) | `services/cortex` |
| Brain | [tools](segments/tools) | `services/tools` |
| Body | [voice](segments/voice) | `services/voice` |
| Body | [mouth](segments/mouth) | `services/mouth` |
| Body | [avatar](segments/avatar) | `services/avatar` |
| Operator | [dashboard](segments/dashboard) | `services/dashboard` |
| Operator | [control-plane](segments/control-plane) | `packages/control` |
| Operator | [deployment](segments/deployment) | `docker-compose.yml`, `Dockerfile`, `scripts/install.sh`, `.github/workflows` |
| Operator | [docs-site](segments/docs-site) | `docs/` and `scripts/docs-check.mjs` |
| Operator | [module-contract](segments/module-contract) | `packages/control/src/manifest.ts`, `packages/config/src/units.ts` and the dashboard's settings editor |

Some segments cross package boundaries. The [module contract](segments/module-contract), for example, is a set of obligations that every service meets, implemented across the control plane, the config package and the dashboard.

## Decisions

The Decisions pages hold the design's decision documents in full. Each records a choice that was hard to reverse or easy to forget the reason for, with the alternatives that were weighed. Two are published today: [external services attach through a connector protocol](decisions/connector-protocol) and [the dashboard as a standalone host program](decisions/standalone-dashboard). A decision that a later one replaces is not published, so the pages show the current choice only.

## Mapping the design onto a running stack

If you want to see the architecture working rather than read about it:

- The [Bus events](../reference/events.md) page lists every message the services exchange, which is the first tenet, "the bus is the only seam", made concrete.
- The Services screen of the [dashboard](../../guide/operate/dashboard.md) shows each service's health, mode and dependencies live.
- [Fake inputs](../testing/inject.md) shows how to feed the system a single [event](../../start/glossary.md#event) and watch it travel through the regions.
- [Ways to extend cohost](../extend/index.md) lists which parts you can swap or add, and how.
