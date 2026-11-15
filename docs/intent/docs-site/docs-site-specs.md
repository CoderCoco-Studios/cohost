# docs-site specs

Prefix `DOCS`. Design: [docs-site-design.md](docs-site-design.md).

Markers: `[x]` implemented; `[ ]` intended but not yet implemented (gap); `[D]` deferred.

Terms used below: a *hand-written page* is a published `.md` file under `docs/` that is not a dynamic-route template (a file named `[param].md`); a *design-excerpt page* is a page a route template and its `*.paths.mjs` loader produce under `docs/advanced/architecture/`; *the docs check* is `scripts/docs-check.mjs`, whose source pass runs with no argument and whose built-site pass runs with `--dist`; *prose* is the text of a page outside its frontmatter, code spans, fenced code blocks, headings and link text, and includes table cells and the text of `:::` containers; a *shell fence* is a fenced code block whose language is `sh`, `bash`, `shell`, `zsh` or `console`; a *command line* in a shell fence is, in a `console` fence, a line starting with `$ ` (with that prefix removed) and, in the other languages, a non-blank line that does not start with `#`.

## Build

- [ ] **DOCS-BUILD-001**: When `pnpm docs:build` runs, it shall run the docs check's source pass, then `vitepress build docs`, then the docs check's built-site pass, in that order, and stop with a non-zero exit at the first step that fails.
- [ ] **DOCS-BUILD-002**: When `pnpm docs:dev` runs, it shall run `vitepress dev docs` and no pass of the docs check.
- [ ] **DOCS-BUILD-003**: The VitePress config shall publish the site under the base path `/cohost/` with clean URLs and VitePress's local search.
- [ ] **DOCS-BUILD-004**: The VitePress config shall leave `ignoreDeadLinks` unset or set it to exactly `'localhostLinks'`, so that `vitepress build` fails on a link to a page that does not exist and skips only `localhost` URLs.
- [ ] **DOCS-BUILD-005**: If either pass of the docs check finds a problem, then it shall print one line per problem naming the file (and the line, where the problem has one) and exit non-zero; when it finds none it shall exit 0.
- [ ] **DOCS-BUILD-006**: The `docs:*` scripts in the root `package.json` shall run no step that writes a `.md` file under `docs/`; every hand-written page is a file committed to the repository.
- [ ] **DOCS-BUILD-007**: The `.gitignore` shall exclude `docs/.vitepress/cache` and `docs/.vitepress/dist` and shall match no `.md` file under `docs/`.
- [ ] **DOCS-BUILD-008**: The site's sidebar and nav shall be defined as data in `docs/.vitepress/sidebar.mjs`, which `docs/.vitepress/config.ts` and the docs check both import, so the check judges the sidebar the site renders.
- [ ] **DOCS-BUILD-009**: The VitePress config shall register a `::: aside` markdown container (the co-host aside) that renders its content in an element with the class `cohost-aside` under the title "The co-host says".

## Publishing boundary

- [ ] **DOCS-PUB-001**: The VitePress `srcExclude` shall exclude `high-level-design.md`, `intent/**`, `decisions/**`, `arrows/**`, `lid/**` and `plans/**`, so none of those files becomes a page of its own or enters the search index.
- [ ] **DOCS-PUB-002**: Each VitePress `srcExclude` pattern other than `decisions/**` and `plans/**`, whose directories may be empty or absent, shall match at least one file under `docs/`.
- [ ] **DOCS-PUB-003**: When the docs check's built-site pass runs, it shall fail if `docs/.vitepress/dist` holds `high-level-design.html` or any file under `intent/`, `decisions/`, `arrows/`, `lid/` or `plans/`.
- [ ] **DOCS-PUB-004**: Every published `.md` file under `docs/` shall be either a page named in the docs-site LLD's Page tree tables or a dynamic-route template under `docs/advanced/architecture/`; the testing guide is the pages under `docs/advanced/testing/` and the spec-driven guide is `docs/project/spec-driven.md`, and `docs/` holds no other copy of either.

## Information architecture

- [ ] **DOCS-IA-001**: The sidebar shall have four sections in this order, "Start here", "Set it up and run it", "Build on it" and "Project", and every page in a section shall carry the `track` of that section: `start`, `simple`, `advanced` and `project` respectively.
- [ ] **DOCS-IA-002**: Every hand-written page named in the docs-site LLD's Page tree tables shall exist at the path the table gives and appear in the sidebar under its table's section and group, in the tables' row order.
- [ ] **DOCS-IA-003**: Every sidebar and nav link to the site shall resolve to a published page.
- [ ] **DOCS-IA-004**: Every published page except the home page (`docs/index.md`) shall appear exactly once in the sidebar.
- [ ] **DOCS-IA-005**: The sidebar's four sections shall not be collapsible (no `collapsed` key); the groups inside "Set it up and run it" (Install, Connect, Tune, Operate) shall be collapsible and open (`collapsed: false`); the groups inside "Build on it" (Testing, Extend, Reference, Architecture) shall be collapsible and closed (`collapsed: true`); "Start here" and "Project" shall hold pages and no groups.
- [ ] **DOCS-IA-006**: The glossary page (`start/glossary.md`) shall turn off its previous and next links, and the How it works page (`start/how-it-works.md`) shall set its next link to the What you need page (`guide/install/prerequisites.md`).
- [ ] **DOCS-IA-007**: The top nav shall link, in order, Start here (`start/what-is-cohost`), Guide (`guide/install/prerequisites`), Advanced (`advanced/dev-setup`) and Project (`project/spec-driven`), and the GitHub repository as a social link.
- [ ] **DOCS-IA-008**: The home page shall offer three entry actions linking the What is cohost? page, the What you need page and the Developer setup page.
- [ ] **DOCS-IA-009**: The sidebar shall nest at most four levels of groups (section, group, subgroup, taxonomy group), with the third and fourth levels used only inside the Architecture group, whose subgroups (Design, Segments, Decisions) and the taxonomy groups inside Segments shall be collapsible and closed (`collapsed: true`).

## Page authoring

- [ ] **DOCS-PAGE-001**: Every hand-written page shall carry frontmatter `title` and `description`, both non-empty, and `track` with one of the values `start`, `simple`, `advanced` or `project`; the home page (`docs/index.md`) carries `track: start`.
- [ ] **DOCS-PAGE-002**: Where a hand-written page contains a fenced code block, its frontmatter shall carry `verified` set to the SHA of a commit on `main` (7 to 40 lowercase hexadecimal characters) whose files the page's commands, defaults and expected output were last checked against; the docs check shall verify the format only.
- [ ] **DOCS-PAGE-003**: Every image in a hand-written page, whether markdown (`![alt](src)`) or an HTML `<img>`, shall have non-empty alt text.
- [ ] **DOCS-PAGE-004**: If the prose of a hand-written page other than `project/verification-log.md`, or of `README.md`, contains "previously", "formerly", "deprecated" or "legacy" (matched case-insensitively as whole words) on a line that does not also carry the comment `<!-- docs-check: allow -->`, then the docs check shall fail naming the file, line and word.
- [ ] **DOCS-PAGE-005**: Each page under `docs/guide/install/` and `docs/guide/connect/` other than `docs/guide/install/prerequisites.md` shall have the `##` headings "What you need", "How you know it worked" and "If it didn't" (a typographic apostrophe matching a straight one), and its "If it didn't" section shall link the troubleshooting page (`guide/troubleshooting.md`).
- [ ] **DOCS-PAGE-006**: The Ways to extend cohost page (`advanced/extend/index.md`) shall present a service built on one of cohost's bus clients, `@cohost/bus` (TypeScript) or `crates/cohost-bus` (Rust), as the supported way to add a service, saying that the Rust route has no example yet, and shall not present a process that uses neither client (for example a service written in Python) as a supported way to extend cohost, saying that such a process gets no event validation, no dashboard control and no health reporting.
- [ ] **DOCS-PAGE-007**: Every hand-written page other than the home page shall have exactly one `#` (H1) heading.

## Glossary

- [ ] **DOCS-GLOSS-001**: The glossary page shall list its terms in frontmatter `terms`, each with a unique `id` and a non-empty `match` list of words or phrases, and shall have one heading per term whose anchor is that term's `id`.
- [ ] **DOCS-GLOSS-002**: When the prose of a hand-written page other than the glossary contains a string from a glossary term's `match` list (matched case-insensitively as a whole word or phrase, an optional trailing "s" included), and the term's `id` is not in the page's frontmatter `glossary-skip` list, that page shall contain at least one link to that term's glossary entry; otherwise the docs check shall fail naming the page and the term.
- [ ] **DOCS-GLOSS-003**: The glossary shall define at least the terms with these ids: `vtuber`, `obs`, `browser-source`, `obs-websocket`, `stt`, `tts`, `llm`, `embedding`, `ollama`, `redis`, `redis-streams`, `bus`, `event`, `consumer-group`, `docker`, `container`, `docker-compose`, `compose-profile`, `postgres`, `pgvector`, `wsl2`, `gpu`, `vtube-studio`, `vrm`, `vmc`, `osc`, `salience`, `affect`, `valence-arousal`, `cortex`, `hook`, `reflex`, `connector`, `sink`, `heartbeat`, `mock-mode`; the everyday words among them (`bus`, `event`, `container`, `hook`, `sink`) are matched like any term, and a page that uses such a word only in its everyday sense lists its id in `glossary-skip`.
- [ ] **DOCS-GLOSS-004**: When the docs check looks for a link to a glossary entry (DOCS-GLOSS-002), it shall count a link whose target is the glossary page with the term's `id` as fragment, written as a relative path to `start/glossary.md` or `start/glossary`, or as the root-relative `/start/glossary#<id>` or `/start/glossary.md#<id>`.

## Links

- [ ] **DOCS-LINK-001**: When the docs check's built-site pass runs, it shall fail for any link in a built page to another page of the site whose fragment names no element id on the target page.
- [ ] **DOCS-LINK-002**: When a hand-written page, `README.md`, a README under `examples/`, or a design-excerpt page after its links are rewritten (DOCS-ARCH-006) links `https://github.com/CoderCoco-Studios/cohost/blob/main/<path>` or `https://github.com/CoderCoco-Studios/cohost/tree/main/<path>`, `<path>` shall exist in the repository as a file (`blob`) or a directory (`tree`); otherwise the docs check shall fail naming the link.
- [ ] **DOCS-LINK-003**: When `README.md` or a README under `examples/` links a page of the site at `https://codercoco-studios.github.io/cohost/<path>`, the docs check's built-site pass shall map `<path>` to its file in `docs/.vitepress/dist` (`<path>.html`, or `<path>index.html` for a path ending in `/`) and fail naming the link when that file does not exist or the link's fragment names no element id in it.

## Facts checked against the repository

Here a page *names* a value when the value appears in it as a code span.

- [ ] **DOCS-FACT-001**: When a command line of a shell fence in a hand-written page or in `README.md` runs `pnpm` and its first token after `pnpm` that is not a flag is a name other than `install`, `i`, `add`, `remove`, `update`, `exec`, `dlx`, `run`, `why`, `list`, `ls`, `store`, `config`, `env`, `outdated`, `prune`, `rebuild`, `setup`, `init`, `import`, `link`, `unlink`, `audit`, `fetch`, `patch`, `pack` and `publish` (for `run`, the token after it), that name shall be a script in the root `package.json`; a command line that passes `--filter`, `-F`, `-r`, `--recursive`, `-C` or `--dir` is not checked, and a shell fence whose first non-blank line is not a command line is skipped; otherwise the docs check shall fail naming the page and the command.
- [ ] **DOCS-FACT-002**: When a command line of a shell fence, or a line of an `env` or `dotenv` fence, in a hand-written page or in `README.md` begins with one or more assignments `NAME=value` (after an optional `export `), each `NAME` in upper snake case shall be named on the Environment and ports page (`advanced/reference/env.md`), including an assignment that prefixes a command (`PORT=4000 pnpm dashboard`); otherwise the docs check shall fail naming the page and the variable.
- [ ] **DOCS-FACT-003**: The Environment and ports page shall name every variable that `.env.example` assigns (`NAME=`) or shows commented out (`# NAME=`).
- [ ] **DOCS-FACT-004**: The Environment and ports page shall name every host port that `docker-compose.yml` publishes, taken as the default number after `${VAR:-default}` substitution, and the dashboard's two ports (`DASHBOARD_PORT`, default 3000, and `DASHBOARD_LAN_PORT`, default 3001).
- [ ] **DOCS-FACT-005**: The Configuration page (`advanced/reference/config.md`) shall name, as a dotted path, every mapping key of `config/config.example.yaml` at every depth, as the path appears in that file: keys under named map entries spelled out (for example `mouth.outputs.discord.gain_db`) and keys inside list items written with `[]` (for example `a.b[].c`); the docs check shall compare the page against that file and fail naming each missing path.
- [ ] **DOCS-FACT-006**: The Bus events page (`advanced/reference/events.md`) shall name every event type that `@cohost/bus` registers in `EventPayloads` (`packages/bus/src/events.ts`).

## Architecture excerpts

- [ ] **DOCS-ARCH-001**: When the site builds, it shall produce one design-excerpt page for each of the HLD's (`docs/high-level-design.md`) sections `## Problem`, `## Approach`, `## Tenets`, `## System Design` and `## Key Design Decisions`, at `advanced/architecture/design/problem`, `approach`, `tenets`, `system-design` and `key-decisions`, each holding that section's text from its heading up to the next `##` heading.
- [ ] **DOCS-ARCH-002**: When the site builds, it shall produce one design-excerpt page for each leaf LLD (a folder `docs/intent/<segment>/` holding `<segment>-design.md` and `<segment>-specs.md`) at `advanced/architecture/segments/<segment>`, holding that LLD's `## Context and Design Philosophy` section up to the next `##` heading, titled with the segment name and described by the segment's role in the HLD Segments table.
- [ ] **DOCS-ARCH-003**: When the site builds, it shall produce one design-excerpt page for each decision document under `docs/intent/*/decisions/` and `docs/decisions/` at `advanced/architecture/decisions/<file name without .md>`, holding the whole document without its frontmatter, for every decision document except one that another decision document's `supersedes:` frontmatter names (a path, or a list of paths, relative to the naming document's directory), which gets no page.
- [ ] **DOCS-ARCH-004**: If a leaf LLD has no `## Context and Design Philosophy` section, one of the five HLD sections of DOCS-ARCH-001 is missing, the segments in the HLD Segments table differ from the set of leaf LLDs, two decision documents share a file name, a `supersedes:` path names no file, or a loader cannot read or parse a design document or its frontmatter, then the site build shall fail naming the file.
- [ ] **DOCS-ARCH-005**: Each design-excerpt page shall open with a line that names its source file, links that file on GitHub (`https://github.com/CoderCoco-Studios/cohost/blob/main/<path>`) and says the full document is there.
- [ ] **DOCS-ARCH-006**: When a design excerpt contains a relative link, the excerpt page shall render it as the GitHub URL of the link's target resolved against the source file's directory (`blob/main/` for a file, `tree/main/` for a directory), keeping any fragment.
- [ ] **DOCS-ARCH-007**: A design-excerpt page shall render its excerpt with Vue interpolation turned off, so text such as `{{ name }}` in a design document is shown as written.
- [ ] **DOCS-ARCH-008**: The sidebar's Architecture group shall list the Reading the design page, then the five HLD excerpt pages in the order of DOCS-ARCH-001, then the segment pages grouped by the HLD Segments table's taxonomy column in that table's row order, then the decision pages, all taken from the same loaders that produce the pages.
- [ ] **DOCS-ARCH-009**: The Reading the design page (`advanced/architecture/index.md`) shall say that the pages beneath it are excerpts of the design documents shown as written, not held to the site's wording and glossary-link rules, and shall link the glossary.
- [ ] **DOCS-ARCH-010**: The loader of each design-excerpt page shall give the page the frontmatter `track: advanced`, a `title` and a `description`.

## README

- [ ] **DOCS-README-001**: `README.md` shall be at most 60 lines long.
- [ ] **DOCS-README-002**: The `##` headings of `README.md` shall be exactly "Quick start", "Documentation" and "License", in that order.
- [ ] **DOCS-README-003**: The Quick start section of `README.md` shall hold one shell fence that clones the repository and changes into the checkout, followed by at most five command lines (a heredoc counting as one) that take the checkout to cohost running in mock mode with no accounts: run `scripts/install.sh` (which creates `.env` from `.env.example`), append the mock-mode lines to `.env` (`LLM_PROVIDER=mock`, `MEMORY_STORE=memory`, `MEMORY_EMBEDDER=hash`, `VOICE_ENGINE=stub`, `CHAT_SOURCE=fake`) and start the dashboard with `pnpm dashboard`; the fence shall be followed by a link to the docs site's Install for real page (`guide/install/real-install`) for real accounts.
- [ ] **DOCS-README-004**: `README.md` shall link the docs site at `https://codercoco-studios.github.io/cohost/`.

## Examples

- [ ] **DOCS-EX-001**: Every `README.md` under `examples/` shall be at most 30 lines long and link a page of the docs site at its `https://codercoco-studios.github.io/cohost/` URL.
- [ ] **DOCS-EX-002**: `examples/modules/README.md` shall name the files in `examples/modules/` (`server.py`, `fixtures/`, `schemas/`), say how to run `server.py`, and link the Brain hooks page (`advanced/extend/hooks`).
- [ ] **DOCS-EX-003**: `examples/README.md` shall list each directory under `examples/` with a one-line description.
- [ ] **DOCS-EX-004**: Every directory directly under `examples/` shall hold a file other than `README.md` that a reader runs or that a runnable example reads; the model-provider recipes, which are `.env` and `config.yaml` lines with nothing to run, are on the Choose a model page (`guide/tune/model.md`).
