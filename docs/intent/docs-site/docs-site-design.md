---
parent: high-level-design
prefix: DOCS
---

# docs-site

Parent: [high-level-design](../../high-level-design.md). Specs: [docs-site-specs.md](docs-site-specs.md).

## Context and Design Philosophy

The docs site is how anyone learns cohost: what it is, how to set it up, how to run a stream with it, and how it is built. It is a VitePress site under `docs/`, published to GitHub Pages under the base path `/cohost/` by the deployment segment's `pages` workflow and built on every pull request by its `docs-build` workflow (deployment DEPLOY-CI-003, DEPLOY-CI-004). This segment owns what the site contains and how it hangs together: the page tree and its two reading tracks, the hand-written pages, the voice they are written in, the glossary, which files are published and which are not, the excerpted architecture pages, the site's theme and personality, the checks the build runs, and the README as a short pointer to the site.

The reader the site is written for knows nothing about the domain: not streaming, not VTubers, not speech-to-text, text-to-speech or language models, not Redis, not Docker. That reader is the owner coming back cold after months away, or anyone reading the open source. Everything follows from that reader:

- **Two tracks, one map.** A *simple* track walks the reader from nothing to a co-host on their stream in plain language, one step per page. An *advanced* track covers the architecture, the reference tables, testing and the ways to extend cohost. Both tracks sit in one sidebar, so the whole map is always visible and the reader picks how deep to go.
- **Every term is defined where it is used.** A glossary defines each piece of jargon once, and every page links a glossary term the first time its prose uses it.
- **Hand-written pages are the source of truth.** Each page is written for its place in the site, in the site's voice. Nothing in the user documentation is copied from or generated out of another file, so there is one place to edit and one voice to keep.
- **The design record is shown, not retold.** The architecture section publishes excerpts of the design documents themselves (the HLD's framing sections, each leaf LLD's Context and Design Philosophy, the current decision documents), extracted at build time, so the site never carries a second, drifting description of the design.
- **Warm, but never in the way.** The site has a character: a small speech-bubble mascot wearing a headset, a warm palette, the co-host's own asides. Legibility beats cleverness every time: every colour pair meets WCAG AA, motion is optional, and the site loads nothing from any other origin, so it reads the same on GitHub Pages and offline.
- **One build, two hosts.** The same build is published on GitHub Pages and served by the owner's own dashboard at the same base path, `/cohost/` (dashboard DASH-DOCS-001), so the owner can read the docs for the checkout they run, offline. Nothing in a page depends on where it is served, except one table on the Service health page that shows live service states when the dashboard serves it and a calm note everywhere else (Served by the dashboard).
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
| Home | `index.md` | Hero, one-line pitch, three entry cards: Start here, Set it up (simple), Build on it (advanced); how a chat line becomes speech, in six steps |
| What is cohost? | `start/what-is-cohost.md` | What the co-host does on a stream, what it is not, what you need (a Linux or WSL2 PC, optionally an NVIDIA GPU, the accounts you want it on), which track to read |
| How it works | `start/how-it-works.md` | One chat line's journey: chat hears it, salience decides it is worth answering, cortex writes a reply, voice speaks it, the dashboard sink or Discord plays it, the avatar moves its mouth; the creature metaphor (senses, brain, body, operator) |
| Glossary | `start/glossary.md` | Every term the site links, one short plain definition each |

**Set it up and run it** (`track: simple`)

| Group | Page | Path | Covers |
| --- | --- | --- | --- |
| Install | What you need | `guide/install/prerequisites.md` | The machine, the OS (Ubuntu/Debian or WSL2), disk and GPU, and what the installer puts on it (Docker, Node, pnpm, the Rust toolchain) |
| Install | Try it with no accounts | `guide/install/first-run.md` | Mock mode from a clean checkout to a talking co-host on the dashboard, building the bus addon first; the WSL2 Docker note |
| Install | Install for real | `guide/install/real-install.md` | `scripts/install.sh`, `.env`, `config.yaml`, `secrets.yaml`, the first real Launch, the model downloads |
| Connect | Twitch chat | `guide/connect/twitch.md` | Reading a channel, the optional login, the token kept on the host |
| Connect | YouTube chat | `guide/connect/youtube.md` | Reading a live broadcast with an API key, the polling floor and the quota |
| Connect | Discord | `guide/connect/discord.md` | Creating and inviting the one bot, the `discord`, `ears` and `mouth` profiles, choosing the guild and channel, where its voice goes |
| Connect | OBS and the voice on stream | `guide/connect/obs.md` | The sink Browser Source on the same PC and on a second PC, the screenshot sense (`eyes`) and obs-websocket |
| Connect | Avatar | `guide/connect/avatar.md` | VTube Studio (2D) and VRM through a VMC app (3D), expressions |
| Connect | MCP tool servers | `guide/connect/mcp.md` | Adding an MCP server, approving its tools, off-LAN flags, what leaves the machine |
| Connect | Built-in tools | `guide/connect/built-in-tools.md` | Clock, stream info, memory lookup and timers, what stream info sends to Twitch and YouTube, timers across a restart |
| Tune | Personality | `guide/tune/personality.md` | `personality.md`, the dashboard editor, the `## Learned` block |
| Tune | When it talks | `guide/tune/talkativeness.md` | Talkativeness, cooldowns, idle chatter, reflexes |
| Tune | Mood | `guide/tune/mood.md` | What the mood is, how it decays, what it changes |
| Tune | Memory and viewer notes | `guide/tune/memory.md` | What it remembers, regulars, viewer notes and the Viewers page, forgetting |
| Tune | Choose a model | `guide/tune/model.md` | Local Ollama sizes, a rented GPU box, the Claude API, Amazon Bedrock, mixing |
| Tune | Choose a voice engine | `guide/tune/voice-engine.md` | Kokoro, Pocket TTS, an OpenAI-compatible server and stub: trade-offs, where the text goes, recipes |
| Operate | Dashboard tour | `guide/operate/dashboard.md` | Every screen and control, the Access dialog, the keyboard shortcuts, the test side sheet |
| Operate | Service health | `guide/operate/health.md` | Reading the Services screen: up, degraded, off, mock; the live state of each service when the dashboard serves the page |
| Operate | Starting and stopping | `guide/operate/start-stop.md` | Launch, Stop, Rebuild, one service at a time, `cohostctl` |
| Operate | After a stream | `guide/operate/after-stream.md` | The consolidation pass, reflection, editing what it learned |
| | Troubleshooting | `guide/troubleshooting.md` | Symptom → cause → fix, grouped by the step the reader was on |
| | FAQ | `guide/faq.md` | Short answers that do not fit a step |

**Build on it** (`track: advanced`)

| Group | Page | Path | Covers |
| --- | --- | --- | --- |
| | Developer setup | `advanced/dev-setup.md` | Workspace layout, `mise install` and the `mise.toml` tasks (`mise run build` builds the bus addon, then `tsc -b` and the UI), the Docker-free dev loop (`mise run infra:up`, `mise run dev`) with the infrastructure containers |
| Testing | Running the tests | `advanced/testing/index.md` | The whole suite, one package, what CI runs |
| Testing | One service on its own | `advanced/testing/isolated.md` | Isolation presets, mock backends, an isolated start from the dashboard |
| Testing | Fake inputs | `advanced/testing/inject.md` | Injection from the dashboard, `bus-pub`, `bus-tail`, the recipes |
| Testing | Real hardware and accounts | `advanced/testing/real-backends.md` | Bringing each real backend in one at a time |
| Testing | Single-PC checklist | `advanced/testing/single-pc.md` | The WSL2 with Docker Desktop checklist |
| Testing | Unit-test helpers | `advanced/testing/helpers.md` | `@cohost/testing` |
| Extend | Ways to extend cohost | `advanced/extend/index.md` | What can be swapped or added, what each route gives you (validation, dashboard control, health): services on the TypeScript or Rust bus client are supported, and a process on neither is not; the Tested examples table (Extension guides) |
| Extend | Brain hooks | `advanced/extend/hooks.md` | `rules`, `llm` and `http` hooks, the five contracts, the reply schemas, the try-it script that checks a hook server in any language, training your own |
| Extend | Hook server in Python | `advanced/extend/hook-server-python.md` | Running and changing `examples/modules/server.py` |
| Extend | Hook server in TypeScript | `advanced/extend/hook-server-typescript.md` | Running and changing `examples/modules/server.ts` on Node alone |
| Extend | Hook server in Rust | `advanced/extend/hook-server-rust.md` | Running and changing the Rust hook server in `examples/modules/rust/` |
| Extend | Your own model server | `advanced/extend/model-server.md` | What cohost asks of an OpenAI-compatible server, pointing cohost at one, and checking the connection against a stub server in Python or TypeScript |
| Extend | Send audio to ears | `advanced/extend/audio-in.md` | Posting a clip to ears' `http` source from Python, TypeScript or `curl`, and turning any audio file into a clip with `sox` or `ffmpeg` |
| Extend | Add an avatar driver | `advanced/extend/avatar-driver.md` | A driver for another avatar app, from a complete example to its place in the avatar service and the config |
| Extend | Add a brain hook | `advanced/extend/new-hook.md` | A new `Module<I, O>` hook inside the repository, from a complete example to its config key |
| Extend | Add a TypeScript service | `advanced/extend/typescript-service.md` | A service on `@cohost/bus` and the shared runtime, from a complete example to its manifest entry and Compose service |
| Extend | Rust bus client | `advanced/extend/rust-bus.md` | Publishing a heartbeat and reading events from Rust with `crates/cohost-bus`, and what a Rust service must do for itself |
| Extend | Connector protocol | `advanced/extend/connector-protocol.md` | The connector protocol, language-neutral: the registration key, the audio streams, frames, tags, flush, the constants and the contract fixtures; what implementations exist |
| Reference | Configuration | `advanced/reference/config.md` | Every key of `config.yaml` |
| Reference | Environment and ports | `advanced/reference/env.md` | Every environment variable and every port |
| Reference | Bus events | `advanced/reference/events.md` | Every event type and its payload |
| Reference | HTTP routes | `advanced/reference/http.md` | The dashboard's routes (including the secret write, the pick lists and the UI's files), voice's audio route, ears' capture endpoint |
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
- **The co-host peeks through.** Now and then a *co-host aside*, a `::: aside` container in the co-host's own voice: dry, a little smug, fond of the streamer. The VitePress config renders it under the title "The co-host says" in an element with the class `cohost-aside`, styled as a speech bubble (see Theme and personality). An aside never carries information the reader needs.
- **Current, not historical.** Pages describe what is true today: no upgrade notes, no deprecated names, no dates, except on the verification log, which is a dated record. The build rejects the words "previously", "formerly", "deprecated" and "legacy" in prose; a line that needs one in its current-tense sense carries `<!-- docs-check: allow -->`.
- **Sentence case** for titles and headings.

## README and examples

`README.md` is a pointer, not a manual: one paragraph saying what cohost is, a quick start that clones the repository, changes into it and then runs at most five command lines: `scripts/install.sh`, which creates `.env`, `config/config.yaml` and `secrets/secrets.yaml` from their examples, and `mise run dashboard`, then an isolated start from the dashboard with no file edited, leaving a co-host talking with no accounts (real accounts are the site's Install for real page), a link to the docs site, and the licence section the deployment segment requires (DEPLOY-LIC-004). It has exactly three `##` sections: Quick start, Documentation, License. The site's URL is `https://codercoco-studios.github.io/cohost/`.

The `examples/` directory keeps runnable files, one directory per task, laid out in Extension guides below. Its `README.md` files are directory guides: what the files in that directory are, how to run them, and a link to the site page that explains them (`examples/modules/README.md` links Brain hooks; `examples/README.md` lists the directories). The explanations live only on the site. Every directory directly under `examples/` holds something a reader runs or a runnable example reads; the model-provider recipes, which are `.env` and `config.yaml` lines with nothing to run, are on the Choose a model page.

## Extension guides

The Extend group answers "how do I do X?" for a developer who wants to add to cohost, in the language they already write. Each guide is one task, carried out with one complete example that a test runs, shown on the page straight from the example's file. A reader new to the domain can follow one: the guides keep the step shape, link the glossary like every page, and say plainly what each route does not give.

### The guides

Two pages are references, read rather than followed: Brain hooks (the hook contracts) and Connector protocol. The other nine are *guides*: each borrows the step shape (one or two sentences on what you will have, `## What you need`, numbered steps, `## How you know it worked`, `## If it didn't`). The table lists, for each page, the example files it shows. The docs check reads the Examples column: each page shows every file listed there through a snippet import (below).

| Page | Task | Examples | Verified by |
| --- | --- | --- | --- |
| `advanced/extend/index.md` | Choose a route; see which languages have tested examples | `examples/service/now-playing.ts` | module-contract MOD-EX-001 to MOD-EX-005 |
| `advanced/extend/hooks.md` | Know what a hook server receives and must answer; check a server in any language with `curl` | `examples/modules/try.sh`, `examples/modules/try.expected.txt` | region-hooks HOOK-EX-016 runs the script against every reference server |
| `advanced/extend/hook-server-python.md` | Serve hooks from Python | `examples/modules/server.py`, `examples/modules/try.sh`, `examples/modules/try.expected.txt` | region-hooks HOOK-EX-001 to HOOK-EX-010, HOOK-EX-016 |
| `advanced/extend/hook-server-typescript.md` | Serve hooks from TypeScript on Node, with no packages | `examples/modules/server.ts`, `examples/modules/try.sh`, `examples/modules/try.expected.txt` | region-hooks HOOK-EX-011, HOOK-EX-012, HOOK-EX-015, HOOK-EX-016 |
| `advanced/extend/hook-server-rust.md` | Serve hooks from Rust | `examples/modules/rust/Cargo.toml`, `examples/modules/rust/src/main.rs`, `examples/modules/try.sh`, `examples/modules/try.expected.txt` | region-hooks HOOK-EX-013 to HOOK-EX-016 |
| `advanced/extend/model-server.md` | Point cohost at any OpenAI-compatible server; check the connection against a stub | `examples/model-stub/stub.py`, `examples/model-stub/stub.ts`, `examples/model-stub/try.sh`, `examples/model-stub/try.expected.txt` | model-backends LLM-EX-001 to LLM-EX-006 |
| `advanced/extend/audio-in.md` | Send a clip to ears from Python, TypeScript or `curl`; convert a recording | `examples/audio-in/send_clip.py`, `examples/audio-in/send-clip.ts`, `examples/audio-in/send.sh`, `examples/audio-in/to-wav-sox.sh`, `examples/audio-in/to-wav-ffmpeg.sh` | ears EARS-EX-001 to EARS-EX-007 |
| `advanced/extend/avatar-driver.md` | Drive another avatar app | `examples/avatar-driver/udp-json.ts` | avatar AVATAR-EX-001 to AVATAR-EX-004 |
| `advanced/extend/new-hook.md` | Put a new judgement behind a hook | `examples/new-hook/shout.ts` | region-hooks HOOK-EX-017 to HOOK-EX-019 |
| `advanced/extend/typescript-service.md` | Add a service in TypeScript | `examples/service/now-playing.ts` | module-contract MOD-EX-001 to MOD-EX-005 |
| `advanced/extend/rust-bus.md` | Publish and read on the bus from Rust | `examples/rust-bus/Cargo.toml`, `examples/rust-bus/src/lib.rs`, `examples/rust-bus/src/main.rs` | event-bus BUS-NAT-EX-001 to BUS-NAT-EX-005 |
| `advanced/extend/connector-protocol.md` | Understand the wire protocol a connector speaks | none | the docs check compares its constants with `packages/bus/fixtures/contract/constants.json` |

### Languages and honesty

The languages with tested examples are the ones whose toolchains the project's CI already has: Python 3 (standard library only), TypeScript on Node, and Rust. Nothing is promised in any other language. A reader in Go, C#, Ruby or anything else uses a language-neutral contract: the hook contracts with `examples/modules/try.sh` to check their server, the ears HTTP route with `examples/audio-in/send.sh`, the OpenAI-compatible API with `examples/model-stub/try.sh`, and the Connector protocol page. The `curl` scripts are tested like the examples, so they are the contract's executable form.

The Ways to extend cohost page carries a *Tested examples* table: one row per task, the columns Task, Python, TypeScript, Rust and Any language with curl. A cell links the guide that shows a tested example in that language, or holds `—`. The docs check holds the table to the pages it links: a Python cell's page imports a `.py` example file, a TypeScript cell's a `.ts` file, a Rust cell's a `.rs` file, and an Any language cell's a `.sh` file.

| Task | Python | TypeScript | Rust | Any language with curl |
| --- | --- | --- | --- | --- |
| Serve a brain hook | Hook server in Python | Hook server in TypeScript | Hook server in Rust | Brain hooks |
| Check a model server connection | Your own model server | Your own model server | — | Your own model server |
| Send audio to ears | Send audio to ears | Send audio to ears | — | Send audio to ears |
| Add an avatar driver | — | Add an avatar driver | — | — |
| Add a brain hook in the repository | — | Add a brain hook | — | — |
| Add a service | — | Add a TypeScript service | Rust bus client | — |
| Write a connector | — | — | — | — |

What each route does not give is said where the reader meets it:

- **A hook server is not a service.** It sends no heartbeat; its health is the `hook.<name>` dependency of the service that calls it, and a failure makes the region answer with its rules. Each hook server guide says so.
- **The Rust bus client is a client, not a runtime.** `crates/cohost-bus` gives the connections, the commands and a typed codec for `service.heartbeat` and the connector registration (event-bus BUS-NAT-RS-008). It has no shared runtime: a Rust service publishes its own heartbeats, answers no `control` command or `inject.request` unless it implements them, and checks no payload of another event type until that type is added to the codec with its fixtures (BUS-NAT-RS-009). The Rust bus client guide says each of these, and the example decodes no payload outside the codec.
- **The connector protocol has one implementation.** Every connector today is TypeScript on `@cohost/bus`; there is no SDK in any other language, and `crates/cohost-bus` has the registration codec but not the frame codec or tag grammar (event-bus Deferred). The protocol is language-neutral by design (connections), so the page describes it fully, held to the contract fixtures, and says that no connector in a language other than TypeScript exists yet and that writing one is not a supported route: there is no SDK, no example and no test for it.
- **A model server is for chat only.** cohost sends it `POST <base_url>/chat/completions` and, for health, `GET <base_url>/models`; embeddings never go to it (memory embeds with Ollama or the hash embedder, `brain.memory.embedder`). The guide gives cohost's side only and links each third-party server's own documentation instead of quoting its launch commands, which no test here can run.
- **A process on neither bus client** is not a supported way to add a service (DOCS-PAGE-006); the HTTP routes are how another language joins in.

### Example layout

Each task has a directory under `examples/`, with a README that names its files and links its guide (DOCS-EX-001):

| Directory | Holds | Owning segment |
| --- | --- | --- |
| `examples/modules/` | The reference hook servers (`server.py`, `server.ts`, the Rust package `cohost-example-hook-server` in `rust/`), `try.sh` with `try.expected.txt`, the shared `fixtures/contracts.json` and the generated `schemas/` | region-hooks |
| `examples/model-stub/` | `stub.py`, `stub.ts`, `try.sh` with `try.expected.txt` | model-backends |
| `examples/audio-in/` | `send_clip.py`, `send-clip.ts`, `send.sh`, `to-wav-sox.sh`, `to-wav-ffmpeg.sh` | ears |
| `examples/avatar-driver/` | `udp-json.ts` | avatar |
| `examples/new-hook/` | `shout.ts` | region-hooks |
| `examples/service/` | `now-playing.ts` | module-contract |
| `examples/rust-bus/` | The Rust package `cohost-example-bus`: `src/lib.rs`, `src/main.rs` and its integration test | event-bus |

The segment that owns the behaviour an example exercises owns the example's specs and test; this segment owns the pages, the READMEs and the checks that keep the pages true to the examples.

Standalone examples (the TypeScript hook server, stub and audio client) use only Node's built-in modules and TypeScript syntax that Node runs by stripping types, so a reader runs them with `node <file>.ts` on Node 22.18 or later and no install. The in-repository examples (the avatar driver, the hook, the service) import the workspace packages they extend, as the code they become does. The examples stay outside the root build, so no build of the services needs `examples/` and the Docker image's stages, which copy only the workspace they build, are unchanged. Every `.ts` file under `examples/` is in one TypeScript project, `examples/tsconfig.json`, which the root `tsconfig.json` does not reference; it sets `erasableSyntaxOnly` and `noEmit`, and `packages/config/test/docs-guides.test.ts` type-checks it with `tsc -p examples/tsconfig.json` during `mise run test`, after the workspace packages it imports are built. The two Rust packages form their own Cargo workspace, `examples/Cargo.toml`, with its own committed `examples/Cargo.lock`, depending on `crates/cohost-bus` by path; the root `Cargo.toml` does not name them. The owning segments' tests build and run them with `cargo … --manifest-path examples/Cargo.toml` (cargo, like Node and Python, always comes from `mise.toml`, so these tests never skip for a missing tool), and `docs-guides.test.ts` checks that the examples workspace builds and that `examples/Cargo.lock` holds every package it shares with the root `Cargo.lock` at the same version, so the examples use exactly the crate versions the services use. The `lint:rust` and `test:rust` tasks cover the root workspace only. Node runs the standalone `.ts` examples directly from 22.18 on, the floor a reader running a copy outside the checkout needs; inside the checkout every example runs on the Node `mise.toml` pins, through its `example:*` task.

### Keeping pages and examples together

A page never holds a copy of example code. It shows example files through VitePress's code import, a line `<<< @/../examples/<path>` with an optional `#<region>` naming a region the file marks with comments (`// #region <name>` and `// #endregion <name>` in TypeScript and Rust, `# region <name>` and `# endregion <name>` in Python and shell scripts). VitePress reads the file at build time, so the page shows what the test ran. VitePress quietly shows the whole file when a named region is missing, so the docs check fails a snippet import whose file or region does not exist.

Around that, the checks hold an Extend page to what a machine can confirm:

- **Program code comes only from imports.** A fenced code block on an Extend page is shell (`sh`, `bash`, `shell`, `zsh`, `console`), YAML (`yaml`, `yml`), an environment file (`env`, `dotenv`) or plain text (`text`, `txt`). Code in any other language is a snippet import.
- **Commands run only what is checked.** A command line of a shell fence on an Extend page runs `pnpm`, `node`, `python3`, `cargo`, `sh`, `cd` or `export`, after any `NAME=value` assignments. Anything else, `curl`, `sox`, `ffmpeg` or a third-party server included, lives in an example script a test runs, and the page imports it. A path under `examples/` on a command line exists, and `cargo -p <name>` names a workspace package.
- **Paths exist.** A code span on an Extend page that is a repository path (starting `packages/`, `services/`, `crates/`, `examples/`, `config/` or `scripts/`, with no `<`, `*` or space) names a file or directory that exists.
- **Config fragments are real config.** Every YAML fence on an Extend page is a fragment of `config/config.yaml`: each of its key paths is a key path of `config/config.example.yaml` (the docs check), and the fragment laid over `config/config.example.yaml` passes `ConfigSchema` (a test in `packages/config/test/docs-guides.test.ts`, which can load the schema; the docs check needs only Node and `yaml`).
- **Shown examples are tested examples.** Every example file a page imports is named, as itself or as a directory holding it, in a test file (`packages/*/test/*.test.ts`, `services/*/test/*.test.ts`) or lies in a package of the examples Cargo workspace whose integration tests a test runs.
- **Expected output is a file too.** A guide that shows what a script prints imports a `.expected.txt` file beside the script; the owning segment's test runs the script and compares each line of its output, parsed as JSON, with the same line of that file, so `1.0` and `1` compare equal across languages.

What the checks cannot see (that a step's prose is right, that a troubleshooting cause is the likely one) is held by `verified:` and review, as on every page.

### Page notes

- **Brain hooks** keeps the contract tables, the hook kinds and their config, the schemas and Training your own; it shows its one line of example code, the critic handler, as a snippet import of `server.py`'s `critic` region. Running a server moves to the three hook server guides, which link back to it for the contract.
- **The hook server guides** each show the whole server file, the run command, the try-it script and its expected output, the config lines that point a hook at the server (`host.docker.internal` from containers), and a section on replacing a stand-in handler with a model. All three serve the same toy judgements on port 8900, so the try-it script and its expected output are shared.
- **Your own model server** shows the config fragment (`llm.provider: openai`, `llm.openai.base_url`, `llm.openai.api_key`), the two requests cohost makes, which settings in it a third-party server must honour (a non-streaming chat completion; a JSON reply's `choices[0].message.content`), and the stub servers with their try-it script; then how to read the `llm` dependency on the Services screen when the server does not answer.
- **Send audio to ears** shows enabling the `http` source (config fragment), each client, the `curl` script, the conversion scripts and the reply's shape; it states that the `sox` and `ffmpeg` scripts are tested only where those programs are installed.
- **The in-repository guides** (avatar driver, brain hook, TypeScript service) each show the complete example, then walk the edits that make it part of cohost, naming each file to change as a checked path and describing the change in prose, because the files they change belong to other segments and carry no example regions. A setting that exists only after the reader's edit (a new `avatar.driver` value, a new hook key, a block in `config/expressions.yaml`) is described in prose too, never as a YAML fence, since the config-fragment checks hold every fence to the configuration as it is.
- **Rust bus client** shows the package, the run command (`cargo run --manifest-path examples/Cargo.toml -p cohost-example-bus`) with `REDIS_URL`, what appears on the Services screen, and the list of what a Rust service does for itself.
- **Connector protocol** is a reference: the registration key and its lease, the capability entries, the audio stream names, the frame fields, tags and reserved tags, flush, loss and back-pressure, each linked to the contract fixture that pins it, and a constants table holding every value of `constants.json`, which the docs check compares with the file.

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

`mise run docs:build` runs, in order: the source checks (`node scripts/docs-check.mjs`), `vitepress build docs`, and the built-site checks (`node scripts/docs-check.mjs --dist`). Any failure stops it with a non-zero exit, naming each problem with its file and line. `mise run docs:dev` runs `vitepress dev docs` alone, for fast editing. The `docs-build` and `pages` workflows already run `mise run docs:build`, so every pull request and every deploy runs the checks.

The sidebar and nav are plain data in `docs/.vitepress/sidebar.mjs`, imported by `docs/.vitepress/config.ts` and by the check.

VitePress's own dead-link check stays on; `ignoreDeadLinks` is unset or `'localhostLinks'`, nothing broader. Source checks (over `docs/` and `README.md`):

- frontmatter: `title`, `description`, a valid `track` on every hand-written page; `verified` on every hand-written page with a fenced code block;
- the sidebar: every entry resolves to a published page, no page appears twice, every published page except the home page appears, and each page's `track` matches its sidebar section;
- glossary links, as above;
- facts, where a page *names* a value by showing it as a code span: in shell fences (`sh`, `bash`, `shell`, `zsh`, `console`; in `console` only `$ ` lines are commands) of a page or the README, `mise run <task>` names a task `mise.toml` defines, a direct `pnpm` or `cargo` command appears only on an Extend page for code outside the checkout (DOCS-FACT-001, DOCS-GUIDE-005), and a fence whose first line is not a command is skipped; every leading `NAME=` assignment on a command line or in an `env` fence (`PORT=4000 mise run dashboard` included) is named on the Environment and ports page; that page names every variable `.env.example` assigns or shows commented, every host port Compose publishes (the default after `${VAR:-default}` substitution) and the dashboard's two; the Configuration page names every key path in `config/config.example.yaml` at every depth as the file spells it, list items as `[]`; the Bus events page names every event type `@cohost/bus` registers;
- GitHub links to this repository, in pages, the README, the examples READMEs and the excerpts after rewriting, name paths that exist;
- the words "previously", "formerly", "deprecated" and "legacy" appear nowhere in hand-written prose or the README, except on the verification log and on a line carrying `<!-- docs-check: allow -->`;
- each page other than the home page has exactly one H1;
- every image has alt text;
- the README's length, sections, quick start and site link; the examples READMEs' links;
- snippet imports on every page, and on Extend pages the fence languages, command lines, repository paths, config fragments, tested examples, the Extension guides table's Examples column, the Tested examples table and the Connector protocol constants (Extension guides).

Built-site checks (over `docs/.vitepress/dist`): no page was built from an excluded file; every internal link with a fragment lands on an element with that id on its target page (VitePress checks pages, not anchors, and glossary links are all anchors); and every link from the README or an examples README to `https://codercoco-studios.github.io/cohost/<path>` maps to a built file (`<path>.html`, or `<path>index.html`) that exists and holds the link's fragment.

The check is a Node script with no dependencies beyond the workspace's, in the pattern of `scripts/lid-check.mjs`; its tests are `packages/config/test/docs-check.test.ts`, beside lid-check's. It also runs the theme checks listed under Theme and personality and the live health checks: in the source pass, that the theme registers `LiveHealth`, that the Service health page uses it once, that its files hold no absolute URL, no WebSocket and no `<style>` block, and that the theme CSS gives `.cohost-live-health` no animation or transition; in the built-site pass, that the built Service health page holds the server-rendered note and the `the-states` anchor. The component's behaviour is tested against `live-health.mjs` in `packages/config/test/live-health.test.ts`.

## Theme and personality

The site looks like VitePress's default theme made warm: the same layout, nav, sidebar, outline, local search and previous/next links, with cohost's own palette, a mascot, track badges, a speech-bubble co-host aside, rendered diagrams and a 404 page with some character. The personality lives in colour, the mascot and the asides; the reading surface stays plain. When a flourish and legibility pull apart, legibility wins.

### Theme files

The theme is `docs/.vitepress/theme/`: `index.ts` extends `vitepress/theme` (the default theme with its bundled fonts), fills its layout slots and registers the one component pages use by name, `LiveHealth` (Served by the dashboard); `tokens.css` holds the palette and nothing else; `style.css` maps VitePress's variables onto the palette and holds every other rule; components sit under `theme/components/`. The co-host aside and flow containers and the Mermaid fence renderer are markdown-it plugins under `docs/.vitepress/`, registered in `config.ts` beside the aside container, so the same markdown renders the same way in tests and in the build.

### Palette

The palette is violet for anything you can click, coral for warmth and decoration, on a warm paper background in light mode and a deep plum in dark mode. Every colour is a `--cohost-<token>` custom property in `tokens.css`, declared once under `:root` (light) and once under `.dark` (dark), each value a six-digit hex literal so a script can compute contrast from the file; `tokens.css` holds those two blocks and nothing else, and every other rule, the print overrides included, is in `style.css`. `style.css` points VitePress's own variables (`--vp-c-bg`, `--vp-c-bg-alt`, `--vp-c-bg-soft`, `--vp-c-text-1` to `-3`, `--vp-c-brand-1` to `-3` (`-1` and `-2` take `brand-1` and `brand-2`; `-3`, like `--vp-button-brand-bg`, takes `button-bg`, the one filled-violet colour), `--vp-button-brand-*`, `--vp-code-block-bg`, `--vp-code-bg`, `--vp-code-color`, `--vp-custom-block-{tip,info,warning,danger,details}-bg` and `--vp-custom-block-{tip,info,warning,danger,details}-text`) at these tokens, so VitePress's components follow the palette without overrides of their own.

The values below are the design; the docs check compares `tokens.css` against this table.

| Token | Light | Dark | Used for |
| --- | --- | --- | --- |
| `bg` | `#FFFCF8` | `#1A1420` | Page background |
| `bg-alt` | `#F8F3EE` | `#211A29` | Sidebar, nav |
| `bg-soft` | `#F7F1EA` | `#2A2133` | Entry cards, search box, flow steps |
| `text-1` | `#251C2E` | `#F4EEF8` | Body text, headings |
| `text-2` | `#574B63` | `#C9BDD3` | Secondary text, sidebar items, diagram labels and lines |
| `text-3` | `#6F637B` | `#A396AE` | Muted text, placeholders |
| `brand-1` | `#6B3FBF` | `#BFA3FF` | Links, active nav and sidebar items, hero name |
| `brand-2` | `#5A30A6` | `#D2BFFF` | Link hover |
| `button-bg` | `#6B3FBF` | `#6A40C4` | Primary button |
| `button-hover-bg` | `#5A30A6` | `#7A4FD6` | Primary button on hover |
| `button-text` | `#FFFFFF` | `#FFFFFF` | Primary button label |
| `accent` | `#E0583F` | `#FF8A70` | Coral decoration: aside border, flow arrows, entry-card strip of Start here |
| `focus` | `#6B3FBF` | `#BFA3FF` | Keyboard focus outline |
| `aside-bg` | `#FFF1EA` | `#2C1E22` | Co-host aside background |
| `aside-title` | `#A63A26` | `#FFB39F` | "The co-host says" |
| `code-bg` | `#F6F2F9` | `#211A29` | Code block background |
| `code-inline-bg` | `#F1EBF7` | `#2E2440` | Inline code background |
| `code-inline-text` | `#5A30A6` | `#D2BFFF` | Inline code text |
| `badge-start-bg` | `#FFE3D9` | `#3D2420` | Start here badge |
| `badge-start-text` | `#9A3420` | `#FFB39F` | Start here badge |
| `badge-simple-bg` | `#DDF3E6` | `#1C3326` | Simple badge |
| `badge-simple-text` | `#1E6B3F` | `#8FDCAE` | Simple badge, Set it up card strip |
| `badge-advanced-bg` | `#ECE3FB` | `#2E2448` | Advanced badge |
| `badge-advanced-text` | `#5A30A6` | `#CDB8FF` | Advanced badge, Build on it card strip |
| `badge-project-bg` | `#E8E6EC` | `#2C2833` | Project badge |
| `badge-project-text` | `#45404D` | `#D4CFDA` | Project badge |
| `tip-bg` | `#E9F6EE` | `#1C3326` | Tip callout |
| `tip-title` | `#1E6B3F` | `#8FDCAE` | Tip callout title and border |
| `info-bg` | `#EEF0F4` | `#262330` | Info and details callouts |
| `info-title` | `#3F4654` | `#C9BDD3` | Info callout title and border |
| `warning-bg` | `#FFF4D6` | `#3A2E12` | Warning callout |
| `warning-title` | `#8A5A00` | `#F5C86A` | Warning callout title and border |
| `danger-bg` | `#FDE7E9` | `#3D1E22` | Danger callout |
| `danger-title` | `#B4232F` | `#FF9AA4` | Danger callout title and border |
| `mascot-body` | `#6B3FBF` | `#8F6BEA` | Mascot's bubble |
| `mascot-face` | `#FFFFFF` | `#FFFFFF` | Mascot's eyes and mouth |
| `mascot-headset` | `#E0583F` | `#FF8A70` | Mascot's headset |

**Contrast pairs.** Each row pairs one foreground token with each listed background token; the ratio (WCAG 2.x relative luminance) must reach the minimum in both light and dark. 4.5 is WCAG AA for normal text; 3 is AA for non-text contrast (outlines, borders, the mascot's shapes). The docs check reads this table.

| Foreground | Backgrounds | Minimum |
| --- | --- | --- |
| `text-1` | `bg`, `bg-alt`, `bg-soft`, `aside-bg`, `code-bg`, `tip-bg`, `info-bg`, `warning-bg`, `danger-bg` | 4.5 |
| `text-2` | `bg`, `bg-alt`, `bg-soft` | 4.5 |
| `text-3` | `bg`, `bg-alt`, `bg-soft` | 4.5 |
| `brand-1` | `bg`, `bg-alt`, `bg-soft`, `aside-bg`, `tip-bg`, `info-bg`, `warning-bg`, `danger-bg` | 4.5 |
| `brand-2` | `bg`, `bg-alt`, `bg-soft` | 4.5 |
| `button-text` | `button-bg`, `button-hover-bg` | 4.5 |
| `aside-title` | `aside-bg` | 4.5 |
| `code-inline-text` | `code-inline-bg` | 4.5 |
| `badge-start-text` | `badge-start-bg` | 4.5 |
| `badge-simple-text` | `badge-simple-bg` | 4.5 |
| `badge-advanced-text` | `badge-advanced-bg` | 4.5 |
| `badge-project-text` | `badge-project-bg` | 4.5 |
| `tip-title` | `tip-bg` | 4.5 |
| `info-title` | `info-bg` | 4.5 |
| `warning-title` | `warning-bg` | 4.5 |
| `danger-title` | `danger-bg` | 4.5 |
| `focus` | `bg`, `bg-alt`, `bg-soft` | 3 |
| `accent` | `bg` | 3 |
| `mascot-body` | `bg` | 3 |
| `mascot-headset` | `bg` | 3 |
| `mascot-face` | `mascot-body` | 3 |

The lowest margin in the table is half a point above its minimum, so a small hand-tweak to one value can tip a pair; the check catches it.

**Code highlighting** uses Shiki's `github-light-high-contrast` theme in light mode and `github-dark-default` in dark mode, set as `markdown.theme` in the config. Every colour either theme gives a token that has no background of its own reaches 4.5:1 against `code-bg` in its mode; the check computes this from the installed Shiki themes, so a VitePress upgrade that changes a theme is caught.

### Type

Text uses Inter, which VitePress's default theme ships as self-hosted font files inside the build; code uses VitePress's system monospace stack (`ui-monospace`, then the platform fonts). The theme adds no font file and no font package. Headings are Inter at weight 700 with slightly tightened letter-spacing; body text stays at VitePress's 16px with its line height. No external font service is used: VitePress removes its optional web-font import from the production build, and the origin check below fails the build if any external stylesheet or font reappears.

### The mascot

The *cohost mark* is a small friendly speech bubble wearing a headset: the co-host as a voice in the room, drawn from simple shapes and original to cohost, not modelled on any real VTuber or logo. One Vue component, `CohostMark.vue`, holds it as inline SVG so it takes the palette and switches with dark mode. It is specified here in words; the implementer draws it within these constraints.

- **Canvas.** `viewBox="0 0 64 64"`, square. It must read at 20px (nav) and look good at 200px (home hero).
- **Bubble (body).** A rounded rectangle about 44 wide and 34 tall, centred a little below the middle, corner radius about 14, with a short rounded tail at its lower left pointing down and left. Fill `--cohost-mascot-body`.
- **Headset.** A band arcing over the top of the bubble from one side to the other, stroke about 4 units, round caps, with an ear cup (a small rounded rectangle) on each side of the bubble at eye height. Colour `--cohost-mascot-headset`. A short microphone boom may curve from the right ear cup towards the bubble's lower right, ending in a small dot.
- **Face.** Two eyes as short upright rounded bars, and a mouth as a three-bar waveform (short, tall, short rounded bars) centred below them. Fill `--cohost-mascot-face`.
- **Limits.** At most 12 shape elements; no `<text>`, gradients, filters, masks, `<image>`, `<use>` of external files or `<style>` element; every colour a `var(--cohost-mascot-*)` reference; strokes and gaps at least 3 units so the 20px rendering does not blur into a blob.
- **Expressions.** The component takes an `expression` prop: `idle` (above), `talking` (the waveform bars animate, used in the home hero only) and `lost` (the 404 page: the bubble tilted about 8 degrees, one eye a little higher than the other, the mouth a single short flat bar).
- **Markup.** The `<svg>` carries `class="cohost-mark"` and `data-expression` set to its expression, so a check can tell the 404 mark from the nav mark.
- **Accessibility.** Beside the site title or other text naming cohost it is decorative (`aria-hidden="true"`); used alone it carries `role="img"` and `aria-label="The cohost mascot"`.
- **Favicon.** `docs/public/favicon.svg` is the idle mark with the light-mode hex values written in (a favicon cannot read page variables) and the boom omitted, linked from every page's `head`.

The mark is unnamed: the co-host's name belongs to each streamer's `personality.md`, so the site calls it "the co-host".

### Nav, footer and social links

The nav bar shows the mark (idle, 24px, decorative) before the site title "cohost". Nav items, the GitHub social link and the footer text stay as the information architecture and the deployment segment's licence requirement set them; the theme only colours them. GitHub is the only social link: the project has no other public channel.

### Track badges

Every page rendered with VitePress's doc layout whose frontmatter has a `track` shows a badge just above its `#` heading, through the default theme's `doc-before` slot: a small rounded label in the track's badge colours.

| `track` | Label | Colours |
| --- | --- | --- |
| `start` | Start here | `badge-start-*` |
| `simple` | Simple | `badge-simple-*` |
| `advanced` | Advanced | `badge-advanced-*` |
| `project` | Project | `badge-project-*` |

The badge is `<span class="cohost-track-badge" data-track="<track>">`, starts with visually hidden text "Track: " so a screen reader announces what it is, and is not a link (one fewer tab stop on every page). Design-excerpt pages carry `track: advanced`, so they show the Advanced badge. The home page uses the home layout and shows none.

### The co-host aside

The aside reads as the co-host leaning in with a comment: a speech bubble in `aside-bg`, corner radius 12px, a 4px coral (`accent`) left border, and a small tail at the top left pointing at its title. The title "The co-host says" is in `aside-title`, bold, preceded by the idle mark at 18px drawn as a CSS mask (a `data:` URL, so nothing is fetched and the markup from the aside container does not change). Body text is `text-1`, upright: never italic, because the aside is read as prose.

### Callouts

VitePress's `tip`, `info`, `warning`, `danger` and `details` containers take the aside's shape without its tail: the type's `-bg` background, a 4px left border and a bold title in the type's `-title` colour (`details` uses the info colours), body text `text-1`. Their default titles stay ("TIP", "WARNING" and so on, in VitePress's wording).

### Diagrams

A fenced code block with language `mermaid`, on a hand-written page or inside a design excerpt (the HLD's System Design section holds one), is rendered at build time to inline SVG by `beautiful-mermaid`, a dependency-light Mermaid renderer that needs no browser. A markdown-it fence rule in the config calls it, so excerpts and hand-written pages render alike and nothing Mermaid-related runs in the reader's browser.

- The renderer is given the palette as CSS variable references (`bg` → `var(--cohost-bg)`, `fg` → `var(--cohost-text-1)`, `muted` and `line` → `var(--cohost-text-2)`, `accent` → `var(--cohost-accent)`, `surface` → `var(--cohost-bg-soft)`, `border` → `var(--cohost-text-3)`), transparent background, font `Inter`, so a diagram follows light and dark mode without being rendered twice.
- The renderer's output carries `@import` rules for a hosted web font; the fence rule removes every `@import` from the SVG's `<style>`. The origin check guarantees none survives.
- The SVG is wrapped in `<figure class="cohost-diagram" tabindex="0">`. The figure scrolls horizontally on its own (`overflow-x: auto`), and the SVG is drawn at its natural width, never scaled below it, so the labels of a wide diagram stay legible on a phone and the page itself never scrolls sideways. `tabindex="0"` lets a keyboard user focus the figure and scroll it.
- The SVG has `role="img"` and `aria-label="Diagram: <heading>"`, where `<heading>` is the text of the nearest heading before the fence on its page; its labels remain real SVG text, so they can be found and copied.
- A fence the renderer cannot parse fails the build, naming the page or the design document and the fence's line.

### Home page

The home page keeps VitePress's home layout and its frontmatter (hero text, three actions, three feature cards), styled:

1. **Hero.** The name "cohost" in `brand-1` (solid colour, no gradient), the line and tagline from frontmatter, the three actions. Beside it, through the `home-hero-image` slot, the mark at 200px with the `talking` expression over a soft `bg-soft` circle; below 960px VitePress stacks the image above the text, and the mark drops to 120px.
2. **Entry cards.** The three feature cards (Start here, Set it up, Build on it, in that order, DOCS-IA-008) on `bg-soft`, each with a 4px top strip in its track's colour: `accent` for Start here, `badge-simple-text` for Set it up, `badge-advanced-text` for Build on it. The whole card is the link, as in the default theme.
3. **How a chat line becomes speech.** A `##` heading of that name, then a `::: flow` container holding an ordered list of six steps, each a short bold name and a few words: **Chat** hears the line; **Salience** decides it is worth answering; **Cortex** remembers and writes a reply; **Voice** turns it into speech; **the sink or Discord** plays it; **the avatar** moves its mouth. Terms link the glossary as on any page. The last line of the container links the How it works page (`start/how-it-works.md`) for the whole journey. The `flow` container renders `<div class="cohost-flow">` around its content. On a narrow screen the steps are a single column joined by a coral line down the left; from 640px they become a wrapping row of `bg-soft` chips joined by coral arrows (CSS-generated, hidden from screen readers), sized so they wrap three and three below 960px and sit as one row of six above it. The ordered list stays an ordered list, so it reads as steps without the styling.
4. **What to do first**, the glossary pointer and the co-host aside, as written in `index.md`.

### 404 page

The default theme's `not-found` slot holds a page that is plain about what happened and lets the co-host shrug. It shows the mark with the `lost` expression, the `#` heading "Page not found", one plain sentence ("There is no page at this address. It may have moved, or the link may have a typo."), a link "Go to the home page" to `/cohost/`, a link to What is cohost?, a note that the search box at the top finds any page, and one co-host line in a `.cohost-aside`: "I looked behind the couch and under the stream deck. Nothing. Let's go back home." The text lives in `theme/components/NotFound.vue`, the one user-facing text outside a markdown page; it is held to the Voice section by review. The built `404.html` is the server-rendered not-found page: VitePress writes an empty app shell for it, so the config's `transformHtml` hook puts the rendered page into the HTML, which makes the page exist without JavaScript and lets the docs check read it. The browser still hydrates it.

### Motion

Motion is decoration, so it is opt-in to the reader's system setting. Every `animation` and `transition` the theme declares sits inside `@media (prefers-reduced-motion: no-preference)`; and a `@media (prefers-reduced-motion: reduce)` block cuts every element's animation and transition to an instant and turns smooth scrolling off, which also covers VitePress's own transitions. The only animation is the hero mark talking: its waveform bars bob for at most three cycles, five seconds in all, on page load, then stop (WCAG 2.2.2 needs no pause control for motion that stops within five seconds). Entry cards lift 2px on hover with a 150ms transition.

### Light and dark

The site follows the reader's `prefers-color-scheme` and keeps VitePress's appearance toggle: the config's `appearance` is left at its default (`true`). Every token has a dark value, so nothing in the theme is designed for one scheme only. Without JavaScript the site shows the light palette.

### Keyboard focus

Every focusable element (links, buttons, `summary`, form fields, `[tabindex]`) shows a 2px solid `focus` outline offset 2px when focused from the keyboard (`:focus-visible`). The theme never removes an outline (`outline: none` or `0`). VitePress's "Skip to content" link stays first in tab order.

### Small screens

The site works at 360px wide with no horizontal page scroll. VitePress's layout already collapses the sidebar and outline, wraps tables in their own horizontal scroller and lets code blocks scroll; the theme keeps to that. Its own rules are written for the narrow screen first and widen inside `@media (min-width: …)` blocks; no theme rule outside such a block sets a `width`, `min-width` or `flex-basis` above 328px (360px less the 16px page gutters), and the diagram SVG, whose natural width may exceed the column, sets none, its figure scrolling on its own.

### Print

A printed page is the article alone, in the light palette: the nav, local nav, sidebar, outline aside, previous/next pager, search and appearance toggle are hidden; `.dark` takes the light token values and highlighted code takes Shiki's light colours; code blocks wrap instead of overflowing; diagrams, asides and callouts do not break across pages; and each link in page content to another site prints its URL after its text. The track badge prints, so a printed page still says which track it belongs to.

### Network

The built site loads nothing from any other origin: no font service, CDN, analytics or remote script. A built page may *link* elsewhere (GitHub, the services a page explains); it may not *load* from elsewhere. This keeps the site private to read and lets the same build be served offline. Search stays VitePress's local index. The one request a page makes at runtime is the live health table's same-origin `GET /services` (Served by the dashboard).

### Theme checks

The docs check enforces what a machine can see:

- Source pass: `tokens.css` matches the Palette table, both modes declare the same tokens as hex literals, every contrast pair reaches its minimum, the configured Shiki themes meet 4.5:1 against `code-bg`, `style.css` maps the listed VitePress variables to tokens, the motion, focus, print and small-screen rules above hold in the theme's CSS, the mark component keeps its limits, the home page holds the flow with its six steps in order, and the Mermaid renderer is pinned in `package.json`.
- Built-site pass: no resource reference to another origin in any built HTML, CSS or inline SVG; every doc-layout page with a `track` carries exactly one badge with that track; no Mermaid fence is left as a code block; every page links the favicon; `404.html` has its heading, its links, the mark and the co-host's line.

What only eyes can judge (the site at 360px and 1280px wide, in light and dark, with reduced motion on, tabbing through a page, the print preview, and the diagrams' legibility) is a manual review. It is recorded on the Verification log page with the commit it was done against, and repeated when the theme changes.

## Served by the dashboard

The dashboard serves this site's build output, `docs/.vitepress/dist`, at the same base path GitHub Pages uses, `/cohost/`, on its full-surface listener (dashboard DASH-DOCS-001 to 012). The build does not know which host serves it: the pages, the links and the assets are identical in both places. `mise run dashboard` runs `mise run docs:build`, which rebuilds when the docs changed, before it starts the dashboard (deployment DEPLOY-HOST-001), so the docs a running dashboard serves match its checkout. The dashboard links into the site twice: its header's `Docs` link opens `/cohost/`, and its Services screen's "how to read this" link opens this site's Service health page at the states table, `guide/operate/health#the-states`, so the built page keeps that anchor (DOCS-LIVE-012).

### Live health

The Service health page explains the states the dashboard's Services screen shows. When the dashboard serves the page, it also shows them: a `<LiveHealth />` component, placed once on that page under its own `##` heading (DOCS-LIVE-002), reads the dashboard's `GET /services` (dashboard DASH-FEED-006) and renders a compact table of every service's current verdict beside the explanation. Served anywhere else (GitHub Pages, `vitepress dev`, `vitepress preview`, a file opened from disk), the same component shows one calm sentence instead and makes no more requests.

- **Files.** The logic is a plain ES module, `docs/.vitepress/theme/live-health.mjs`, with no Vue import: it validates an answer, turns each service into the text of its row, and runs the request schedule with `fetch`, the timers and the document's visibility passed in. `docs/.vitepress/theme/components/LiveHealth.vue` is a thin view over it, registered globally by the theme's `enhanceApp` (DOCS-LIVE-001). The module is tested under `node:test` with stubs (`packages/config/test/live-health.test.ts`), as the dashboard's page script is tested under a stub DOM, so no browser and no Vue test harness are needed.
- **Server render.** During the build, and in the browser until a first valid answer arrives, the component renders an element with the class `cohost-live-health` holding one status line, "Live data shows here when you open these docs from your dashboard.", and no table (DOCS-LIVE-003). A reader without JavaScript, a printed page and the Pages site all show that line.
- **The request.** `GET` of the root-relative URL `/services`: the dashboard's own route at the page's origin, deliberately not under the base path. It is sent with `cache: 'no-store'` and `accept: application/json`, carries no credentials beyond the browser's same-origin default, and is aborted after 4000 ms (DOCS-LIVE-004). The component's files hold no absolute URL and open no WebSocket (DOCS-LIVE-013); the dashboard sends no CORS header, so the component can only ever read the dashboard that served it.
- **A valid answer** has status 200, a `content-type` beginning `application/json`, and a body that parses to an object whose `services` is an array of objects, each with a string `service` and a string `state`. Anything else is a failed request: the HTML 404 page that GitHub Pages or `vitepress dev` returns, the network error of a page opened from disk, a timeout, a body that does not parse. Every error is caught; nothing the component meets is thrown (DOCS-LIVE-005).
- **Schedule.** The first request goes out when the component is mounted while the document is visible, or else when the document next becomes visible. If it fails, the status line stays and the component makes no further request while it stays mounted (DOCS-LIVE-006): on Pages that is one quiet 404, never repeated. After a valid answer, the next request goes out 5000 ms after the previous one finished, so at most one is in flight; while the document is hidden none goes out, and when it becomes visible again one goes out at once; when the component unmounts (the reader navigates to another page) the request in flight is aborted and none is scheduled (DOCS-LIVE-007). 5000 ms is the default heartbeat interval, so polling faster would rarely show anything new.
- **The table** (DOCS-LIVE-008) has the caption "Your services right now, from your dashboard" and one row per entry of `services`, in the answer's order (the manifest's order, then any other service that has sent a heartbeat). The columns come from the dashboard's `ServiceHealth` (control-plane, `packages/control/src/health.ts`):

  | Column | From | Shown as |
  | --- | --- | --- |
  | Service | `service` | the name |
  | State | `state`, and `needs` when present | the state; when `needs` holds at least one entry with a string `service` and `state`, a second line `needs cortex (down), needs memory (stale)` |
  | Mode | `heartbeat.mode` | the mode, or `—` when there is no heartbeat or no string mode |
  | Last heartbeat | `lastSeenAgeMs` | whole seconds, rounded down, as `12 s ago`; `never` when it is not a number |
  | Restarts | `restarts` | the number, or `—` when it is not a number |

  Every value is rendered as text, never as HTML. Dependencies, the heartbeat's detail and the container restart count are left out: the dashboard's Services screen shows them, and this table is a glance beside the explanation of the states.
- **When the dashboard stops answering** after a valid answer, the component keeps the last table, its status line says "Not updating: the dashboard is not answering.", and it keeps to the 5000 ms schedule; the next valid answer replaces the table and the status line says "Live from your dashboard." again (DOCS-LIVE-009).
- **Accessibility.** The table is a real table (`<table>`, `<caption>`, `<th scope="col">`). The status line is the one element with `aria-live="polite"`, and its text changes only when the component moves between its three conditions (the note, live, not updating), never on a routine refresh, so a screen reader is not interrupted every five seconds; the table itself is not a live region (DOCS-LIVE-010).
- **Look.** The component has no `<style>` block. Its rules are in `style.css` under `.cohost-live-health`, in palette tokens, so they follow light and dark mode and fall under the theme checks; they declare no animation or transition, so reduced motion asks nothing of them (DOCS-LIVE-011). The table takes VitePress's own table styling.

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
| Where checks run | `scripts/docs-check.mjs` inside the `docs:build` task, before and after `vitepress build` | Inside `scripts/lid-check.mjs`; inside the `test` task; a separate workflow | `docs:build` already runs on every pull request and every deploy, so no workflow changes; lid-check is about the arrow, not the site; the `test` task would build the site on every test run. |
| Dead links | VitePress's check on, skipping only `localhost` links | A pattern list that skips links into the design tree | A skip list hides real breakage; links into the design tree are GitHub URLs, which need no skip. |
| Content obligations about a feature | Stay in the segment that owns the feature (deployment's install and dashboard-start pages, for example), naming the site page. Exception: what the Ways to extend cohost page says about supported extension routes (DOCS-PAGE-006) is this segment's, because it speaks for the whole system rather than one segment's files | Move every "the docs shall say X" spec into this segment | The owning segment knows when the fact changes and cascades the page with it; this segment owns structure, voice and checks. The extension-route statement draws on the HLD (tenets 1 and 12) and the module contract together, so no single feature segment owns it. |
| Theme base | Extend VitePress's default theme through its CSS variables and layout slots, in the same leaf LLD | A theme written from scratch; a third-party VitePress theme; a sibling leaf LLD for the theme | The default theme already gives an accessible layout, local search, a responsive sidebar and previous/next links; replacing it means re-proving all of that. A third-party theme adds a dependency and someone else's look. The theme's specs share this segment's docs check, pages and build, and nothing outside the site depends on them, so a separate leaf would split one check script across two segments for no cascade benefit. |
| Palette | Violet for interactive elements, coral for warmth and decoration, warm paper (light) and deep plum (dark) backgrounds; hex tokens in one file, every text pair AA (4.5:1) and non-text pair 3:1, checked from the LLD's table | VitePress's default indigo; a pastel palette; colours computed with `color-mix()` | Violet and coral give cohost a look of its own that still reads as calm. Pastels fail AA for text. Hex literals let a script compute every ratio; `color-mix()` would need a colour engine in the check. The check reads the LLD's table so the design and the file cannot drift apart. |
| Code highlighting themes | `github-light-high-contrast` (light) and `github-dark-default` (dark) | VitePress's defaults (`github-light`, `github-dark`); `one-light`/`one-dark-pro`; `vitesse` | Against the palette's `code-bg`, the defaults and the others have token colours below 4.5:1 (comments around 3.5 to 4.4); these two pass for every token colour. |
| Fonts | Inter as VitePress bundles it (self-hosted in the build) plus the system monospace stack | System UI stack only; a rounded display face from a font package; a font CDN | Inter is already in the build at no new cost and reads well at small sizes. A display face would add a dependency and weight for a little personality the mascot already gives. A CDN breaks offline serving and leaks readers to a third party. |
| Mascot | An original, unnamed speech bubble with a headset and a waveform mouth, inline SVG with three expressions | A character illustration; an emoji; naming it after the example personality | A few flat shapes read at 20px and in both schemes, and inline SVG takes the palette. An illustration needs an artist and does not scale down. The co-host's name is each streamer's choice in `personality.md`, so the site does not name it. |
| Track badges | A non-link label above the `#` heading from the `doc-before` slot, with hidden "Track: " text | A link to the track's first page; a coloured sidebar per track; text in the page title | A label tells the reader where they are without adding a tab stop to every page. Per-track sidebars break the one-map decision. Changing titles would change what search and the browser tab show. |
| Diagram rendering | `beautiful-mermaid` at build time inside a markdown-it fence rule, a build-only dev dependency, its web-font `@import` stripped | Client-side `mermaid` bundled into the site (`vitepress-plugin-mermaid`); `@mermaid-js/mermaid-cli` or `mermaid-isomorphic`, which drive a headless browser; a hand-drawn SVG; leaving the fence as code | Build-time SVG costs the reader no script, works without JavaScript and in print, and is checkable in the built HTML. Client-side Mermaid ships a large bundle and renders after load. A headless browser adds a large download to every docs build in CI. A hand-drawn copy is a second description of the design that drifts. A code block is unreadable to the reader the site is for. |
| Wide diagrams | Natural width, never scaled below it, inside a figure that scrolls on its own | Scale to fit any width; full content width with a minimum width; let the page scroll | Scaling the 1770px-wide system diagram to a 328px column, or to any width below its natural one, makes its labels a few pixels tall. A minimum width still shrinks wider diagrams. A scrolling page breaks the 360px rule for every other element on it. |
| Motion | Opt-in through `prefers-reduced-motion: no-preference`, one hero animation that stops within five seconds, a global reduce block | No motion at all; a looping idle animation | A little movement on the home page is part of the character; a loop would distract from reading and need a pause control (WCAG 2.2.2). |
| Checking the narrow layout | CSS rules checked by the docs check (narrow-first rules, no fixed width above 328px outside a `min-width` query) and a manual review recorded on the Verification log | A headless-browser test (Playwright) measuring `scrollWidth` at 360px in CI | A browser download in every docs build is a large cost for one assertion; the CSS rules prevent the usual causes, and the review catches the rest at each theme change. |
| Network origins | The built site loads nothing from another origin; search stays local | Algolia DocSearch; a font CDN; analytics | The dashboard serves the same build offline, and a reader should not be tracked for reading docs. |
| Home page flow | Six steps written in `index.md` inside a `::: flow` container | A Vue component with the steps in it; a Mermaid diagram | Steps in markdown are a hand-written page's prose, so the glossary and wording checks cover them and they read as a list without the styling. A diagram of six boxes is heavier than the list and harder to read on a phone. |
| Feedback and edit links | None: no "Was this page helpful?" and no "Edit this page" link | A feedback widget; VitePress's `editLink` | Feedback needs a service to receive it, which the network rule forbids. An edit link would point design-excerpt pages at their route template rather than the document they show. |
| Live health data source | The dashboard's `GET /services`, same origin, root-relative URL, polled | the `/ws` feed; a CORS header on the dashboard so the Pages site can read a local dashboard; no live data on the site | `/services` is the health tracker's snapshot in one small JSON answer; `/ws` streams every bus event, far more than a table needs. A CORS header would let any website the owner's browser opens read their local dashboard. Without live data the reader switches between the Services screen and its explanation. |
| Knowing the dashboard served the page | Send one request and judge the answer | check `location.hostname` for a loopback name; a build-time flag; a marker the dashboard injects | The full surface may be reached as `localhost`, an IP address or a LAN name listed in `dashboard.allowed_hosts` (`DASHBOARD_HOST`), and the build is the same for every host, so the answer itself is the only reliable sign. Elsewhere it costs one same-origin 404. |
| Refresh schedule | 5000 ms after the previous request finished, only while the page is visible; none after a first failure | every 1000 ms (the tracker's tick); a fixed `setInterval`; retrying a first failure with backoff | Heartbeats arrive every 5 s by default, so faster polling shows almost nothing new. Chaining after completion keeps one request in flight on a slow answer. A first failure means the page is not served by a dashboard, and that does not change while it is open. |
| Where the component's logic lives | A plain module (`live-health.mjs`) with injected `fetch`, timers and document, under a thin Vue view | everything in the `.vue` file, tested with Vue Test Utils and jsdom; a browser harness | No new test dependency; the request, validation and row rules are tested directly under `node:test`, in the pattern of the dashboard's page tests. |
| Extension guide granularity | One page per task, and for the hook server one page per language; a reference page for each contract (Brain hooks, Connector protocol) that the guides link | One page per task with a VitePress code group switching languages; one page per language holding every task | A reader new to the domain follows one page top to bottom; the setup, run command and failures differ by language (Python's standard library, Node's type stripping, a Cargo build), so a code group would leave the steps around it wrong for two of three readers. Grouping by language would split the task a reader came with across pages. The contracts stay on one reference page each, so three guides never restate them. |
| Extend sidebar shape | One flat Extend group in reading order: overview, Brain hooks, the three hook server guides, then the other tasks, the Connector protocol last | Subgroups inside Extend (Hook servers, Inside the repository, Rust); a fifth sidebar section for guides | Twelve titled pages read well as one list, and subgroups would need a third sidebar level outside Architecture (DOCS-IA-009) for a gain of one click. A new section would separate the guides from the overview that chooses between them. |
| Example code on pages | VitePress code imports (`<<<`) of the example files, regions marked in the examples only, with the docs check failing a missing file or region | Fenced copies compared with the source by the docs check; copies kept by review; regions marked in production files the guides describe | An import cannot drift: the build shows the file the test ran. A comparison check would report drift after the fact and make every example edit a two-file edit. Regions in production files (the config schema, the driver registry) would put documentation markers into other segments' code; the in-repository guides name those files as checked paths and describe the change in prose instead. |
| What an Extend page may run | Shell lines run `pnpm`, `node`, `python3`, `cargo`, `sh`, `cd` or `export`; everything else is an imported, tested script; no hand-written program code | Any command, held by `verified:`; a list of allowed third-party programs | A command a test never runs is the one that silently breaks. Moving `curl`, `sox` and `ffmpeg` into scripts makes each one a file a test executes and a page imports, at the cost of a script per recipe. Third-party servers' launch commands change with their releases, which no test here can follow, so the page links their documentation. |
| Expected output | A `.expected.txt` file imported by the page, compared line by line as JSON by the owning segment's test | Output written in the page; a byte-for-byte comparison | Written output drifts like copied code. JSON comparison lets three languages print `1.0` or `1` and still share one expected file and one try-it script. |
| Languages with tested examples | Python (standard library), TypeScript on Node, Rust: the toolchains CI already installs; any other language through the `curl` scripts and the contracts | Examples in Go, C#, Ruby or Java, untested; examples in every language CI could install | An untested example is a promise nothing keeps. Adding a toolchain to CI for each language costs every pull request time for readers who may not exist; the contracts and the tested `curl` scripts serve every language equally. |
| TypeScript hook server, stub and audio client | `.ts` files using only Node built-ins and erasable syntax, run with `node <file>.ts` (Node 22.18 or later), type-checked in the root build | Plain JavaScript (`.mjs`); TypeScript run through `tsx`; a small npm package per example | The reader asked for TypeScript, and Node runs these files directly, so no install step stands between the reader and a running server. `tsx` is a workspace dependency a reader outside the repository lacks. A package per example adds a `package.json`, a lockfile entry and an install for a single file. |
| Rust hook server | Standard library HTTP over `std::net` plus `serde_json`, at the version the root workspace locks | A web framework (`axum`, `tiny_http`); a hand-written JSON parser | No crate enters the examples lockfile that the services do not already use, and the whole server fits on one page. A framework is what a reader would use for production, and the guide says so, but it would add a dependency tree to every CI build for an example. Parsing JSON by hand would teach the wrong thing. |
| Where example tests live | In the owning segment's existing test directory (packages, services), naming the example by path; the Rust bus example's integration test in its package's `tests/`, run by a `packages/bus` test | One `examples/test/` suite; tests inside each example directory | The owning segment's test already has the real validators, providers and listeners the example must satisfy, and `mise run test` already runs those directories. A separate suite would duplicate those fixtures and need its own glob in the `test` task. |
| Examples and the root build | `examples/tsconfig.json` and the examples Cargo workspace (`examples/Cargo.toml`, `examples/Cargo.lock`) stand apart from the root manifests; tests type-check, build and run them | Reference the examples project from the root `tsconfig.json` and add the Rust packages to the root Cargo workspace | Root membership would make every build of the services need `examples/`, including the Docker image's `native` and `build` stages, which copy only what the services need; the image build contexts stay unchanged this way. The cost is that CI's root `cargo fmt` and `cargo clippy` steps do not lint the examples, and a second lockfile, which a test holds to the root lockfile's versions. |
| A guide for a TypeScript connector | Not written; the Connector protocol page is the reference and names `@cohost/bus`'s registrar, registry and frame functions | A step-by-step connector guide with an example connector | There is one connector, and the registrar and frame API it uses have changed with it; a guide now would document a moving surface that one implementation has exercised. Deferred until a second connector exists. |
| Voice out over HTTP | The overview's paragraph on `mouth`'s `http` output, with no guide or receiver example | A receiver example in Python and TypeScript with a mouth test | The overview already states the request mouth sends; a receiver is a few lines of any web framework. Deferred with the guides that would need a mouth test. |
| Narration check | Four words ("previously", "formerly", "deprecated", "legacy") fail the build outside the verification log, with a same-line `<!-- docs-check: allow -->` escape | Review only; a longer list including "no longer" and "upgrading" | Upgrade notes and "previously" lines are the commonest way a page stops reading cold. "No longer" and "upgrading" have common current-tense uses (a line no longer playing, upgrading the GPU driver), so they would fail correct pages. |

## Open Questions & Future Decisions

### Deferred

1. **More extension guides.** A guide and example for a TypeScript connector, once a second connector exists; a receiver for `mouth`'s `http` output; examples in another language once CI installs its toolchain.
2. **EARS IDs in excerpts.** Excerpts cite spec IDs that are not published; linking each to its line on GitHub is left for later.

## Non-goals

- Publishing the EARS spec files, the arrows overlay, the LID workflow or working plans.
- Versioned docs: the site documents `main`.
- Translations.
- Page feedback widgets, comments, analytics or any other feature that sends the reader's activity anywhere.
- "Edit this page" links.
- A light/dark choice beyond VitePress's toggle (a high-contrast or custom theme picker).
- Pixel-level visual regression tests and a headless browser in the docs build.
- Documenting a cohost service that uses neither bus client (`@cohost/bus`, `crates/cohost-bus`) as a supported route. A Rust service on `crates/cohost-bus` is supported (HLD tenet 12); the Rust bus client guide shows the client and says what a Rust service does for itself.
- Examples or guides in a language without a tested example; launch commands for third-party model servers.
- A connector SDK in any language.

## References

- Files: `docs/**/*.md` except the unpublished paths above, `docs/.vitepress/config.ts`, `docs/.vitepress/sidebar.mjs`, the `*.paths.mjs` loaders under `docs/advanced/architecture/`, the markdown-it plugins under `docs/.vitepress/` (aside and flow containers, Mermaid fence renderer), `docs/.vitepress/theme/` (`index.ts`, `tokens.css`, `style.css`, `components/CohostMark.vue`, `components/TrackBadge.vue`, `components/NotFound.vue`, `components/LiveHealth.vue`, `live-health.mjs`), `docs/public/favicon.svg`, `scripts/docs-check.mjs`, `README.md`, `examples/README.md` and the README of each directory under `examples/`, `examples/tsconfig.json`, the examples Cargo workspace (`examples/Cargo.toml`, `examples/Cargo.lock`), `packages/config/test/docs-guides.test.ts`, the `docs:*` scripts in `package.json`, `.gitignore` (VitePress cache and output, `examples/target`).
- Example owners (Extension guides, Example layout): region-hooks (HOOK-EX-*), model-backends (LLM-EX-*), ears (EARS-EX-*), avatar (AVATAR-EX-*), module-contract (MOD-EX-*), event-bus (BUS-NAT-EX-*). The Connector protocol page describes connections' protocol and checks its constants against event-bus's contract fixtures (BUS-NAT-FIX-001).
- Other segments: deployment runs the build in CI and on Pages (DEPLOY-CI-003, DEPLOY-CI-004) and owns the licence text the footer and README name (DEPLOY-LIC-004) and the install, dashboard-start and testing content specs that name site pages; every segment's LLD is excerpted, so a missing Context and Design Philosophy section fails this segment's build. Deployment also runs the build at `mise run dashboard` when the docs changed (DEPLOY-HOST-001); its image build does not copy `examples/`, which no root manifest names. The dashboard serves `docs/.vitepress/dist` at `/cohost/` (DASH-DOCS-001 to 012), answers the live health table's `GET /services` (DASH-FEED-006) and links `guide/operate/health#the-states` from its Services screen (DASH-UI-025).
- External: VitePress 1.6.4 (dynamic routes, local search, dead-link check, default theme slots and CSS variables, bundled Inter, Shiki themes), `beautiful-mermaid` (build-time Mermaid to SVG; MIT; depends on `elkjs` and `entities`; the version is taken from the npm registry when it is added and pinned exactly), GitHub Pages, WCAG 2.2 (contrast 1.4.3 and 1.4.11, pause 2.2.2, focus visible 2.4.7, reflow 1.4.10).
