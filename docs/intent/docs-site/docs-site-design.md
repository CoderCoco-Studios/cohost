---
parent: high-level-design
prefix: DOCS
---

# docs-site

Parent: [high-level-design](../../high-level-design.md). Specs: [docs-site-specs.md](docs-site-specs.md).

## Context and Design Philosophy

The docs site is how anyone learns cohost: what it is, how to set it up, how to run a stream with it, and how it is built. It is a VitePress site under `docs/`, published to GitHub Pages under the base path `/cohost/` by the deployment segment's `pages` workflow and built on every pull request by its `docs-build` workflow (deployment DEPLOY-CI-003, DEPLOY-CI-004). This segment owns what the site contains and how it hangs together: the page tree and its two reading tracks, the hand-written pages, the voice they are written in, the glossary, which files are published and which are not, the excerpted architecture pages, the checks the build runs, and the README as a short pointer to the site.

The reader the site is written for knows nothing about the domain: not streaming, not VTubers, not speech-to-text, text-to-speech or language models, not Redis, not Docker. That reader is the owner coming back cold after months away, or anyone reading the open source. Everything follows from that reader:

- **Two tracks, one map.** A *simple* track walks the reader from nothing to a co-host on their stream in plain language, one step per page. An *advanced* track covers the architecture, the reference tables, testing and the ways to extend cohost. Both tracks sit in one sidebar, so the whole map is always visible and the reader picks how deep to go.
- **Every term is defined where it is used.** A glossary defines each piece of jargon once, and every page links a glossary term the first time its prose uses it.
- **Hand-written pages are the source of truth.** Each page is written for its place in the site, in the site's voice. Nothing in the user documentation is copied from or generated out of another file, so there is one place to edit and one voice to keep.
- **The design record is shown, not retold.** The architecture section publishes excerpts of the design documents themselves (the HLD's framing sections, each leaf LLD's Context and Design Philosophy, the current decision documents), extracted at build time, so the site never carries a second, drifting description of the design.
- **What a page states, a machine checks where it can.** Dead links, orphan pages, missing glossary links, commands that name scripts that do not exist, variables the reference does not list, and pages leaking out of the unpublished design tree all fail the build. What no machine can check is pinned to the commit it was last checked against.

The docs site is held to the HLD's bar for documentation: a defect in it is a bug, fixed with the same weight as a code defect.

## Reader and tracks

Every published page belongs to exactly one track, declared in its frontmatter (`track:`) and matched by the sidebar group it sits in.

| Track | Reader's question | Promise to the reader |
| --- | --- | --- |
| `start` | "What is this, and is it for me?" | No prior knowledge; no commands to run. |
| `simple` | "How do I get it on my stream and keep it running?" | Plain language; every step says what you will see when it worked; nothing is assumed beyond the pages before it in the sidebar. |
| `advanced` | "How does it work, and how do I change or extend it?" | Precise; may assume the simple track and the glossary; jargon is still linked. |
| `project` | "How is the project run?" | Licence, contribution, how specs work, what has been verified. |

The simple track is ordered as a path: the sidebar order is the reading order, and VitePress's previous/next links walk it from installing, through connecting accounts and tuning the co-host, to operating it during and after a stream. A simple-track page may link forward into the advanced track for a reader who wants more, but never depends on it.

## Page tree

Paths are relative to `docs/`; the URL is the path without `.md` under `/cohost/` (clean URLs; `index.md` is the directory URL). The sidebar is one tree in this order.

**Start here** (`track: start`)

| Page | Path | Covers |
| --- | --- | --- |
| Home | `index.md` | Hero, one-line pitch, three entry cards: Start here, Set it up (simple), Build on it (advanced) |
| What is cohost? | `start/what-is-cohost.md` | What the co-host does on a stream, what it is not, what you need (a Linux or WSL2 PC, optionally an NVIDIA GPU, the accounts you want it on), which track to read |
| How it works | `start/how-it-works.md` | One chat line's journey: chat hears it, salience decides it is worth answering, cortex writes a reply, voice speaks it, the dashboard sink or Discord plays it, the avatar moves its mouth; the creature metaphor (senses, brain, body, operator) |
| Glossary | `start/glossary.md` | Every term the site links, one short plain definition each |

**Set it up and run it** (`track: simple`)

| Group | Page | Path | Covers |
| --- | --- | --- | --- |
| Install | What you need | `guide/install/prerequisites.md` | The machine, the OS (Ubuntu/Debian or WSL2), disk and GPU, and what the installer puts on it (Docker, Node, pnpm, the Rust toolchain) |
| Install | Try it with no accounts | `guide/install/first-run.md` | Mock mode from a clean checkout to a talking co-host on the dashboard, building the bus addon first; the WSL2 Docker note |
| Install | Install for real | `guide/install/real-install.md` | `scripts/install.sh`, `.env`, `config.yaml`, the first real Launch, the model downloads |
| Connect | Twitch chat | `guide/connect/twitch.md` | Reading a channel, the optional login, the token kept on the host |
| Connect | Discord | `guide/connect/discord.md` | Creating and inviting the one bot, the `discord`, `ears` and `mouth` profiles, choosing the guild and channel, where its voice goes |
| Connect | OBS and the voice on stream | `guide/connect/obs.md` | The sink Browser Source on the same PC and on a second PC, the screenshot sense (`eyes`) and obs-websocket |
| Connect | Avatar | `guide/connect/avatar.md` | VTube Studio (2D) and VRM through a VMC app (3D), expressions |
| Tune | Personality | `guide/tune/personality.md` | `personality.md`, the dashboard editor, the `## Learned` block |
| Tune | When it talks | `guide/tune/talkativeness.md` | Talkativeness, cooldowns, idle chatter, reflexes |
| Tune | Mood | `guide/tune/mood.md` | What the mood is, how it decays, what it changes |
| Tune | Memory and viewer notes | `guide/tune/memory.md` | What it remembers, regulars, viewer notes and the Viewers page, forgetting |
| Tune | Choose a model | `guide/tune/model.md` | Local Ollama sizes, a rented GPU box, the Claude API, Amazon Bedrock, mixing |
| Operate | Dashboard tour | `guide/operate/dashboard.md` | Every tab and control, the test panel |
| Operate | Service health | `guide/operate/health.md` | Reading the Services tab: up, degraded, off, mock |
| Operate | Starting and stopping | `guide/operate/start-stop.md` | Launch, Stop, Rebuild, one service at a time, `cohostctl` |
| Operate | After a stream | `guide/operate/after-stream.md` | The consolidation pass, reflection, editing what it learned |
| | Troubleshooting | `guide/troubleshooting.md` | Symptom → cause → fix, grouped by the step the reader was on |
| | FAQ | `guide/faq.md` | Short answers that do not fit a step |

**Build on it** (`track: advanced`)

| Group | Page | Path | Covers |
| --- | --- | --- | --- |
| | Developer setup | `advanced/dev-setup.md` | Workspace layout, `pnpm build` (the bus addon, then `tsc -b`), the Docker-free dev loop with the infrastructure containers |
| Testing | Running the tests | `advanced/testing/index.md` | The whole suite, one package, what CI runs |
| Testing | One service on its own | `advanced/testing/isolated.md` | Isolation presets, mock backends, an isolated start from the dashboard |
| Testing | Fake inputs | `advanced/testing/inject.md` | Injection from the dashboard, `bus-pub`, `bus-tail`, the recipes |
| Testing | Real hardware and accounts | `advanced/testing/real-backends.md` | Bringing each real backend in one at a time |
| Testing | Single-PC checklist | `advanced/testing/single-pc.md` | The WSL2 with Docker Desktop checklist |
| Testing | Unit-test helpers | `advanced/testing/helpers.md` | `@cohost/testing` |
| Extend | Ways to extend cohost | `advanced/extend/index.md` | What can be swapped or added, what each route gives you (validation, dashboard control, health): services on the TypeScript or Rust bus client are supported, and a process on neither is not |
| Extend | Brain hooks | `advanced/extend/hooks.md` | `rules`, `llm` and `http` hooks, the contracts, `examples/modules/server.py`, training your own |
| Reference | Configuration | `advanced/reference/config.md` | Every key of `config.yaml` |
| Reference | Environment and ports | `advanced/reference/env.md` | Every environment variable and every port |
| Reference | Bus events | `advanced/reference/events.md` | Every event type and its payload |
| Reference | HTTP routes | `advanced/reference/http.md` | The dashboard's routes, voice's audio route, ears' capture endpoint |
| Reference | Commands | `advanced/reference/commands.md` | Root `pnpm` scripts, `cohostctl`, Compose profiles and one-shots |
| Architecture | Reading the design | `advanced/architecture/index.md` | How the design record is organised, how to read an excerpt, how it maps onto the code |
| Architecture | Design excerpts | `advanced/architecture/design/<section>` | One page per HLD section: `problem`, `approach`, `tenets`, `system-design`, `key-decisions` |
| Architecture | Segments | `advanced/architecture/segments/<segment>` | One page per leaf LLD: its Context and Design Philosophy |
| Architecture | Decisions | `advanced/architecture/decisions/<decision>` | One page per current decision document |

**Project** (`track: project`)

| Page | Path | Covers |
| --- | --- | --- |
| How specs work | `project/spec-driven.md` | Linked-intent development as this project uses it |
| Licence | `project/license.md` | AGPL-3.0-only and the commercial licence in plain words, links to `LICENSE`, `COMMERCIAL.md` |
| Contributing | `project/contributing.md` | What contributing involves (the CLA, AGPL terms), linking `CONTRIBUTING.md` and `CLA.md` on GitHub for the terms themselves |
| Status | `project/status.md` | What has run against real accounts and apps and what has not |
| Verification log | `project/verification-log.md` | Dated records of live runs |

The sidebar has four levels at most. Level 1 is the four sections (Start here, Set it up and run it, Build on it, Project), always open. Level 2 is the groups inside a section: Install, Connect, Tune and Operate are open; Testing, Extend, Reference and Architecture start closed. Start here and Project hold pages directly. Levels 3 and 4 exist only inside Architecture: the subgroups Design (the five HLD excerpts), Segments (holding one taxonomy group per HLD Segments taxonomy value, platform, senses, brain, body, operator, in that table's order) and Decisions, all starting closed.

The top nav links the start of each track: Start here (What is cohost?), Guide (What you need), Advanced (Developer setup) and Project (How specs work), plus the GitHub repository. The home page's three entry actions go to What is cohost?, What you need and Developer setup.

The glossary sits outside the previous/next path: its frontmatter turns both links off, and How it works links forward to What you need.

## Page authoring

A *hand-written page* is a published `.md` file under `docs/` other than a dynamic-route template (a file named `[param].md`); a *design-excerpt page* is one a template and its loader produce. The rules below are for hand-written pages unless they say otherwise.

### Frontmatter

Every hand-written page opens with:

```yaml
---
title: Try it with no accounts        # the page's name in the sidebar, the browser tab and search
description: One sentence saying what the reader gets from this page.
track: simple                          # start | simple | advanced | project
verified: 1a2b3c4                      # see "Verified against"
---
```

`title`, `description` and `track` are required on every hand-written page; the home page (`index.md`) carries `track: start` and stays out of the sidebar. `title` is the short name the sidebar, the browser tab and search show; each page other than the home page has exactly one `#` heading, the heading the reader sees at the top of the page, which may be fuller than `title`.

A page may also carry `glossary-skip:` (see Glossary links).

### Verified against

A hand-written page that contains a fenced code block carries `verified:`, the SHA (7 to 40 lowercase hex characters) of a commit on `main` whose files the page's commands, defaults, ports, variables and expected output were last checked against. Whoever edits such a page re-checks what they touched and updates the SHA. The build checks the SHA's format only; anything a machine can compare is checked by the build (below), and `verified:` covers the rest and tells a later reader how old the check is.

### Glossary links

The glossary page's frontmatter lists its terms:

```yaml
terms:
  - id: redis              # the anchor of the term's heading on the glossary page
    match: [Redis]         # words or phrases that count as using the term
  - id: compose-profile
    match: [Compose profile]
```

Each term has a heading on the glossary page with that anchor (`### Redis {#redis}`). On every other hand-written page, each term whose `match` text appears in prose has at least one link to its glossary entry on that page; by convention the link is on the first use. A match is case-insensitive, on whole words or phrases, with an optional trailing "s" (`containers` uses `container`). Prose is the page's text outside frontmatter, code spans, code blocks, headings and link text; table cells and the text inside `:::` containers are prose. A link counts when it targets the glossary page with the term's id as fragment, whether written relative (`../start/glossary.md#redis`, `glossary#redis`) or root-relative (`/start/glossary#redis`, `/start/glossary.md#redis`).

Some required terms are everyday words (`bus`, `event`, `container`, `hook`, `sink`). They are matched like any other term; a page that uses such a word only in its everyday sense lists its id in its frontmatter `glossary-skip: [event]`, which turns the check off for that term on that page.

Design-excerpt pages are not held to this rule or to the wording rule (they are the design record shown as written); the architecture index page tells the reader so and links the glossary.

### Shape of a step page

The Install and Connect pages other than What you need (which is itself the list of what comes first) are step pages: the reader follows them in order and ends with something working. Each has this shape, and any other simple-track page that walks the reader through steps borrows it:

1. One or two sentences: what you will have when you finish.
2. A `## What you need` section: the pages and accounts that come first.
3. Numbered steps, one action each, commands copy-pasteable one per line.
4. A `## How you know it worked` section: what you will see.
5. A `## If it didn't` section: the likely causes, linking the troubleshooting page.

Advanced pages are reference-shaped: tables for keys, routes and events; prose for how and why.

### Links

- Between pages: relative links to the `.md` file, so VitePress checks them.
- To repository files: `https://github.com/CoderCoco-Studios/cohost/blob/main/<path>` (a file) or `.../tree/main/<path>` (a directory), and only to paths that exist.
- To the unpublished design tree: only through the architecture section, or as a GitHub URL.
- `http://localhost:...` URLs are instructions for the reader's own machine and are the only links the dead-link check skips.

Every image carries alt text that says what the image shows.

## Voice

The site speaks to the reader as "you", warmly and plainly, the way a friend who already set this up would talk you through it.

- **Plain first.** Short sentences. One idea per sentence. A term the reader may not know is linked to the glossary the first time it appears.
- **Concrete.** Name the button, the file, the line; show what the screen will say.
- **Honest.** Say what is slow, what downloads several gigabytes, what has not been tried against the real service yet. Never promise more than the code does.
- **Light humour, sparingly.** At most a line here and there, never in a step the reader must follow exactly, never at the reader's expense.
- **The co-host peeks through.** Now and then a *co-host aside*, a `::: aside` container in the co-host's own voice: dry, a little smug, fond of the streamer. The VitePress config renders it under the title "The co-host says" in an element with the class `cohost-aside`, which the theme project styles. An aside never carries information the reader needs.
- **Current, not historical.** Pages describe what is true today: no upgrade notes, no deprecated names, no dates, except on the verification log, which is a dated record. The build rejects the words "previously", "formerly", "deprecated" and "legacy" in prose; a line that needs one in its current-tense sense carries `<!-- docs-check: allow -->`.
- **Sentence case** for titles and headings.

## README and examples

`README.md` is a pointer, not a manual: one paragraph saying what cohost is, a quick start that clones the repository, changes into it and then runs at most five command lines (a heredoc counts as one): `scripts/install.sh`, which creates `.env` from `.env.example`, the mock-mode lines appended to `.env`, and `pnpm dashboard`, leaving a co-host talking with no accounts (real accounts are the site's Install for real page), a link to the docs site, and the licence section the deployment segment requires (DEPLOY-LIC-004). It has exactly three `##` sections: Quick start, Documentation, License. The site's URL is `https://codercoco-studios.github.io/cohost/`.

The `examples/` directory keeps runnable files: `examples/modules/` holds `server.py`, its `fixtures/` and the generated `schemas/`. Its `README.md` files are directory guides: what the files in that directory are, how to run them, and a link to the site page that explains them (`examples/modules/README.md` links Brain hooks; `examples/README.md` lists the directories). The explanations live only on the site. Every directory directly under `examples/` holds something a reader runs or a runnable example reads; the model-provider recipes, which are `.env` and `config.yaml` lines with nothing to run, are on the Choose a model page.

## Architecture section

The design-excerpt pages are VitePress dynamic routes: a `*.paths.mjs` loader beside each route template reads the design documents at build time and returns each page's content. No excerpt is written to disk.

- **Design** (`advanced/architecture/design/[section].md`): one page for each of the HLD's `## Problem`, `## Approach`, `## Tenets`, `## System Design` and `## Key Design Decisions` sections, from its heading to the next `##` heading.
- **Segments** (`advanced/architecture/segments/[segment].md`): one page per leaf LLD (`docs/intent/<segment>/<segment>-design.md`), holding its `## Context and Design Philosophy` section. The page title is the segment name and its description the segment's role from the HLD Segments table.
- **Decisions** (`advanced/architecture/decisions/[decision].md`): one page per decision document under `docs/intent/*/decisions/` and `docs/decisions/`, whole and without its frontmatter. Every decision document is published except one that another decision document names in its `supersedes:` frontmatter, whose value is a path, or a list of paths, relative to the naming document's directory (`supersedes: ../../ears/decisions/listen-speak-split.md`). The URL slug is the file's name without `.md`; two decision documents with the same name fail the build.

Every excerpt page opens with a line naming its source file, linked on GitHub, and saying that the full document lives there. A relative link inside an excerpt is rewritten to the GitHub URL of the file it points at, anchor kept, because the files it points into are not published. Excerpt content is rendered with Vue interpolation off (`v-pre`), so `{{ }}` in a design document is shown as text. Each loader gives its pages `track: advanced`, a `title` and a `description` in their frontmatter.

The loaders fail the build, naming the file, when a leaf LLD has no Context and Design Philosophy section, when one of the five HLD sections is missing, when the HLD Segments table and the set of leaf LLDs under `docs/intent/` disagree, when a `supersedes:` path names no file, or when they cannot read or parse a design document or its frontmatter. The sidebar's architecture entries come from the same loaders, so a new segment or decision appears without a sidebar edit.

## Publishing boundary

Published: every `.md` file under `docs/` that is not excluded, plus the excerpt pages above.

Not published, and absent from the search index: `docs/high-level-design.md`, `docs/intent/**` (LLDs, EARS spec files, decision documents as files), `docs/decisions/**` (project-level decision documents), `docs/arrows/**`, `docs/lid/**` and `docs/plans/**` (working plans, including superseded ones). These are VitePress `srcExclude` entries; each matches at least one file, except `decisions/**` and `plans/**`, whose directories may be empty or absent. The design tree reaches readers only through the excerpt pages.

`docs/` holds no hand-written page outside the Page tree: the testing guide is the pages under `advanced/testing/` and the spec-driven guide is `project/spec-driven.md`, with no other copy of either.

## Build and checks

`pnpm docs:build` runs, in order: the source checks (`node scripts/docs-check.mjs`), `vitepress build docs`, and the built-site checks (`node scripts/docs-check.mjs --dist`). Any failure stops it with a non-zero exit, naming each problem with its file and line. `pnpm docs:dev` runs `vitepress dev docs` alone, for fast editing. The `docs-build` and `pages` workflows already run `pnpm docs:build`, so every pull request and every deploy runs the checks.

The sidebar and nav are plain data in `docs/.vitepress/sidebar.mjs`, imported by `docs/.vitepress/config.ts` and by the check.

VitePress's own dead-link check stays on; `ignoreDeadLinks` is unset or `'localhostLinks'`, nothing broader. Source checks (over `docs/` and `README.md`):

- frontmatter: `title`, `description`, a valid `track` on every hand-written page; `verified` on every hand-written page with a fenced code block;
- the sidebar: every entry resolves to a published page, no page appears twice, every published page except the home page appears, and each page's `track` matches its sidebar section;
- glossary links, as above;
- facts, where a page *names* a value by showing it as a code span: in shell fences (`sh`, `bash`, `shell`, `zsh`, `console`; in `console` only `$ ` lines are commands) of a page or the README, `pnpm <name>` names a root `package.json` script, judged on the first non-flag token after `pnpm` and skipping pnpm's own commands and any command that passes `--filter`, `-r`, `-C` or `--dir`, and a fence whose first line is not a command is skipped; every leading `NAME=` assignment on a command line or in an `env` fence (`PORT=4000 pnpm dashboard` included) is named on the Environment and ports page; that page names every variable `.env.example` assigns or shows commented, every host port Compose publishes (the default after `${VAR:-default}` substitution) and the dashboard's two; the Configuration page names every key path in `config/config.example.yaml` at every depth as the file spells it, list items as `[]`; the Bus events page names every event type `@cohost/bus` registers;
- GitHub links to this repository, in pages, the README, the examples READMEs and the excerpts after rewriting, name paths that exist;
- the words "previously", "formerly", "deprecated" and "legacy" appear nowhere in hand-written prose or the README, except on the verification log and on a line carrying `<!-- docs-check: allow -->`;
- each page other than the home page has exactly one H1;
- every image has alt text;
- the README's length, sections, quick start and site link; the examples READMEs' links.

Built-site checks (over `docs/.vitepress/dist`): no page was built from an excluded file; every internal link with a fragment lands on an element with that id on its target page (VitePress checks pages, not anchors, and glossary links are all anchors); and every link from the README or an examples README to `https://codercoco-studios.github.io/cohost/<path>` maps to a built file (`<path>.html`, or `<path>index.html`) that exists and holds the link's fragment.

The check is a Node script with no dependencies beyond the workspace's, in the pattern of `scripts/lid-check.mjs`; its tests are `packages/config/test/docs-check.test.ts`, beside lid-check's.

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
| --- | --- | --- | --- |
| Where user documentation is written | Hand-written pages under `docs/`; the README is a short pointer | Generate the guide from `README.md` at build time; keep one long README and a thin site | A single README cannot serve a newcomer and a developer at once, and a generated page cannot be shaped for its place in a two-track site. Hand-written pages give one place to edit each topic and one voice. The README stays short so it has nothing to drift. |
| Example READMEs | Directory guides that link the site page; the explanation lives on the site; a directory under `examples/` exists only for files a reader runs or a runnable example reads, so the model-provider recipes live on the Choose a model page | Include the READMEs into site pages at build time; keep them as full documents and link to GitHub; a recipes-only directory beside the runnable ones | The examples' prose is user documentation and belongs in the tracks (Choose a model is a simple-track step; Brain hooks is an advanced page). Including a README verbatim would fix the site page to the README's shape and its relative links would break; two full copies would drift. A directory with only prose has nothing for a reader to run. |
| Architecture section | Build-time excerpts of the HLD, each LLD's Context and Design Philosophy, and current decision documents, through VitePress dynamic routes | Hand-written summaries; publish the HLD and LLDs whole; VitePress `<!--@include-->` regions marked in the design documents | Summaries would be a second description of the design that drifts. Publishing whole LLDs puts EARS citations, code paths and audit notes in front of a reader who wants the why. Region includes would need markers in every design document and cannot rewrite relative links, which VitePress resolves against the including page. A loader knows each excerpt's source path, so it can rewrite links and name the source. |
| Links inside excerpts | Rewritten to GitHub URLs, anchors kept | Rewrite to the matching excerpt page when one exists; strip links | Most links point at sections that are not excerpted; one rule is predictable, and GitHub shows the full document the reader was sent to. |
| Reading tracks | One sidebar with both tracks and Start here, simple groups expanded and advanced collapsed | A sidebar per track keyed by path; separate sites | The newcomer sees the whole map and how deep it goes; previous/next follows one order. |
| Glossary links | Every hand-written page links each glossary term its prose uses, at least once, checked by the build, with a per-page `glossary-skip` list | Link only on simple-track pages; rely on review; leave everyday words out of the glossary | The reader is the same person on both tracks. Everyday words such as bus and event carry a technical meaning cohost depends on, so they stay in the glossary; the skip list lets a page that uses one in its everyday sense say so, instead of the check guessing. |
| Stating commands and defaults | Build checks for what a machine can compare (scripts, variables, config keys, event types, repository paths); `verified:` SHA on pages with code blocks for the rest | Check nothing; generate reference tables from code | The pages are hand-written by decision, so the facts in them need a guard. A SHA records how stale a manual check is; generated tables would break the hand-written model for the pages most likely to drift. |
| Where checks run | `scripts/docs-check.mjs` inside `pnpm docs:build`, before and after `vitepress build` | Inside `scripts/lid-check.mjs`; inside `pnpm test`; a separate workflow | `docs:build` already runs on every pull request and every deploy, so no workflow changes; lid-check is about the arrow, not the site; `pnpm test` would build the site on every test run. |
| Dead links | VitePress's check on, skipping only `localhost` links | A pattern list that skips links into the design tree | A skip list hides real breakage; links into the design tree are GitHub URLs, which need no skip. |
| Content obligations about a feature | Stay in the segment that owns the feature (deployment's install and dashboard-start pages, for example), naming the site page. Exception: what the Ways to extend cohost page says about supported extension routes (DOCS-PAGE-006) is this segment's, because it speaks for the whole system rather than one segment's files | Move every "the docs shall say X" spec into this segment | The owning segment knows when the fact changes and cascades the page with it; this segment owns structure, voice and checks. The extension-route statement draws on the HLD (tenets 1 and 12) and the module contract together, so no single feature segment owns it. |
| Narration check | Four words ("previously", "formerly", "deprecated", "legacy") fail the build outside the verification log, with a same-line `<!-- docs-check: allow -->` escape | Review only; a longer list including "no longer" and "upgrading" | Upgrade notes and "previously" lines are the commonest way a page stops reading cold. "No longer" and "upgrading" have common current-tense uses (a line no longer playing, upgrading the GPU driver), so they would fail correct pages. |

## Open Questions & Future Decisions

### Deferred

1. **Look and personality (next project).** A custom VitePress theme: track badges from `track:`, a styled co-host aside, Mermaid rendering for the HLD's system diagram (until then it shows as a code block). Nothing in this design depends on it.
2. **Docs served by the dashboard (next project, with the dashboard segment).** The dashboard serves the built site at `/cohost/` with a Docs tab and a published health page, plus an optional live-health component that degrades when the page is not served by the dashboard. This design keeps the site a static build under base `/cohost/` with no runtime call to any cohost service, so the same build serves both.
3. **Extension guides (next project).** How-to pages under Extend: a hook server in Python or any language, any OpenAI-compatible model server, sending audio into ears over HTTP, a TypeScript avatar driver, hook or service, and a connector protocol reference. Until they exist the sidebar lists only Ways to extend cohost and Brain hooks.
4. **EARS IDs in excerpts.** Excerpts cite spec IDs that are not published; linking each to its line on GitHub is left for later.

## Non-goals

- Publishing the EARS spec files, the arrows overlay, the LID workflow or working plans.
- Versioned docs: the site documents `main`.
- Translations.
- Documenting a cohost service that uses neither bus client (`@cohost/bus`, `crates/cohost-bus`) as a supported route. A Rust service on `crates/cohost-bus` is supported (HLD tenet 12) and the extend overview says so, with no example yet.

## References

- Files: `docs/**/*.md` except the unpublished paths above, `docs/.vitepress/config.ts`, `docs/.vitepress/sidebar.mjs`, the `*.paths.mjs` loaders under `docs/advanced/architecture/`, `scripts/docs-check.mjs`, `README.md`, `examples/README.md`, `examples/modules/README.md`, the `docs:*` scripts in `package.json`, `.gitignore` (VitePress cache and output).
- Other segments: deployment runs the build in CI and on Pages (DEPLOY-CI-003, DEPLOY-CI-004) and owns the licence text the footer and README name (DEPLOY-LIC-004) and the install, dashboard-start and testing content specs that name site pages; every segment's LLD is excerpted, so a missing Context and Design Philosophy section fails this segment's build.
- External: VitePress 1.6.4 (dynamic routes, local search, dead-link check), GitHub Pages.
