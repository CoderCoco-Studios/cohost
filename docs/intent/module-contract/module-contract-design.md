---
parent: high-level-design
prefix: MOD
---

# module-contract

Status: built: the settings editor (MOD-CFG, MOD-UI), the manifest declarations and derived lists, needs, pause, the test drawer and `POST /inject/event`. Open: the isolated-stack run (MOD-TEST-007) waits for the first real run ([module-contract-specs.md](module-contract-specs.md)). Parent: [high-level-design](../../high-level-design.md) (System Design: Module contract). Sibling: [shared-runtime](../shared-runtime/shared-runtime-design.md), which fulfils obligation 4. Implemented across [control-plane](../control-plane/control-plane-design.md) (the manifest and controller), [config](../config/config-design.md) (schema export and section editing) and [dashboard](../dashboard/dashboard-design.md) (routes and page); this segment owns the rules those pieces follow together.

## Context and Design Philosophy

cohost has ten application services, and the owner operates each of them in the same few ways: change its settings, start, stop or restart it, see whether it is healthy, and feed it a test input without a live stream. Before this contract each of those was partly there and partly special-cased: settings were edited by hand only, the dashboard and the health tracker each kept a list of services by hand, pause existed on the bus with no button, and only three services took a test input from the page.

The contract makes those four abilities obligations of every service, and makes the control plane's manifest the one place a service declares how it meets them. The dashboard and `cohostctl` read the declarations and need no per-service code.

Guiding rules:

- **Declare, do not special-case.** A service's settings sections, the services it uses, whether it honours `pause`, and its test inputs are fields of its manifest entry. A page or CLI branch on a service id is a defect.
- **The schema is the form.** The settings editor renders, validates and writes from the config schema the loader already enforces; nothing describes a setting twice.
- **The file stays the owner's.** `config.yaml` remains the source of truth, editable by hand at any time; the editor changes it as a careful person would (comments, placeholders and unrelated keys untouched).
- **Restart is the apply.** A saved setting takes effect when the services that read it restart; no service learns to reload its configuration live.

## The four obligations

A service meets the contract when all four hold:

| Obligation | Met by | Checked by |
|---|---|---|
| 1. Configurable from the dashboard | Its manifest entry names every `config.yaml` section it reads | A test that every section a service reads (by its config type usage) is declared, and every declared path exists in the schema |
| 2. Independently operable | A manifest unit with a Compose service and a heartbeat; it keeps running when a service it uses is stopped (tenet 5) | Control-plane specs; a test that every application unit has a Compose service and every Compose application service a unit |
| 3. Test-injectable with no platform account | An isolation preset (tenet 6) and at least one declared test input | A test that every application unit declares a test input whose event type exists in the bus registry |
| 4. Built on the shared runtime | Its entry point is `runService`; it uses the shared module for every concern the shared runtime covers | Review; a test that each service's entry file calls `runService` |

## Service descriptor (manifest)

Each application unit in `SERVICE_MANIFEST` carries, beside its existing fields (`groups`, `defaultMode`, `infra`, `requires`, `isolatedEnv`):

| Field | Meaning |
|---|---|
| `config` | Dotted schema paths of the sections the service reads (`voice`, `brain.salience`, `llm`) |
| `uses` | Services whose absence degrades one of this service's features (cortex uses salience, affect, memory; mouth uses voice); `requires` stays the subset an isolated start brings up, and must be a subset |
| `pause` | Whether the service honours `pause` (salience, cortex, affect) |
| `test.inputs` | The inputs the dashboard may feed it: service-level injection kinds (`text`, `image`, `audio`) or bus event types |
| `test.observe` | The event types that show its reaction, for the filtered feed |

The manifest is the one list of services. Everything else derives from it:

- the health tracker's known services (application units);
- the page's unit list, served by `GET /services/manifest` (ungated, like `GET /services`) instead of a constant in the page;
- `cohostctl status`'s list;
- the settings editor's section-to-service map;
- the test drawer's inputs and feed filter.

The Compose file stays hand-written; a test ties it to the manifest in both directions.

Initial declarations (the `config` and `uses` values are the owning segments' to confirm in Phase 3):

| Unit | `config` | `uses` | `pause` | `test.inputs` | `test.observe` |
|---|---|---|---|---|---|
| chat | `chat` | | no | `text` (service) | `chat.message`, `inject.result` |
| eyes | `vision` | | no | `image` (service) | `vision.summary`, `inject.result` |
| ears | `ears` | | no | `audio` (service) | `speech.heard`, `inject.result` |
| salience | `brain.salience`, `brain.working_memory_events`, `cohost`, `llm` | affect, cortex | yes | `chat.message`, `speech.heard`, `vision.summary` | `attention.focus`, `brain.say` |
| affect | `brain.affect`, `cohost`, `llm` | | yes | `chat.message`, `speech.heard`, `vision.summary`, `brain.say` | `affect.state` |
| memory | `brain.memory`, `cohost`, `llm` | | no | `chat.message`, `memory.recall.request` | `memory.recall.reply`, `memory.viewer` |
| cortex | `brain.cortex`, `brain.working_memory_events`, `cohost`, `llm` | salience, affect, memory | yes | `attention.focus` | `brain.status`, `brain.say` |
| voice | `voice` | | no | `brain.say` | `voice.utterance`, `voice.playing`, `voice.done` |
| mouth | `mouth` | voice | no | `brain.say` (through voice) | `voice.playing`, `voice.done`, `voice.failed` |
| avatar | `avatar` | voice | no | `brain.say`, `affect.state` | `avatar.state` |

The `dashboard` section is read by the dashboard itself, which is not a unit: it applies on the dashboard's next start.

## Settings editor

### Routes (dashboard)

| Route | Gated | Behaviour |
|---|---|---|
| `GET /config/schema` | no | `{ sections: [{ path, title, services, schema, secrets }] }`: every declared section, the services that read it, its JSON Schema generated from the zod schema, and the paths of its secret keys |
| `GET /config/:section` | no | `{ section, etag, keys, unknown }` (below) |
| `PUT /config/:section` | yes | Validate and write; `?dryRun=1` validates and writes nothing |

`:section` is a declared dotted path; anything else is `404`. Bodies are capped at 64 KiB like the other JSON routes.

### Reading a section

`etag` is the SHA-256 of the whole `config.yaml` as read. For each key in the section, `keys` gives:

| Field | Meaning |
|---|---|
| `value` | The value the services see: placeholders substituted from the dashboard's environment, schema defaults applied. Absent for a secret |
| `source` | `literal` (written in the file), `env` (`${VAR}`), `env-default` (`${VAR:-d}`), `default` (absent from the file; schema default), `composite` (a string mixing text and placeholders) |
| `env` | For `env` and `env-default`: `{ name, set }`, whether the variable is set in the dashboard's environment |
| `raw` | The text in the file, for `literal`, `env-default` (the default part) and `composite` |
| `editable` | false for secrets, `env`, `composite` |

`unknown` lists keys in the section the schema does not know (the loader's unknown-key warning, scoped to the section).

A key is a scalar or an array (arrays of objects included) under the section, named by its dotted path relative to the section (`openai.api_key` in `llm`); a section that is itself a scalar (`brain.working_memory_events`) has one key named for its last path segment. `unknown` carries dotted paths from the file's root (`brain.salience.reflexes[0].cooldwn_ms`).

Secrets (the schema marks them; today `llm.openai.api_key`, `llm.claude.api_key` and `vision.obs.password`) are never returned, only whether they are set (`secret: true`, `set`). They live in `.env` (tenet 7) and are not editable here.

### Writing a section

`PUT` takes `{ etag, values }`, where `values` maps keys of the section to new values:

1. `etag` must match the file as it is now, else `409 { ok: false, etag }` with the current etag, and nothing is written.
2. A key that is not editable, or not in the schema, is `400` naming it.
3. Each value is applied to the parsed YAML document: a `literal` or `default` key gets the literal; an `env-default` key keeps `${VAR:-…}` and gets the new default. Comments, key order, other sections and unknown keys are kept.
4. The edited text runs through the same pipeline as `loadConfig` (substitution from the dashboard's environment, null dropping, `ConfigSchema`). Issues are `400 { ok: false, issues: [{ path, message }] }` and nothing is written.
5. With `?dryRun=1` the route stops here: `200 { ok: true, dryRun: true, warnings }`.
6. The text is written to a temporary file in the config directory and renamed over `config.yaml`.
7. `200 { ok: true, etag, restart, warnings }`: `restart` lists the units that read the section and that the latest stack status shows running; `warnings` names each `env-default` key whose variable is set (the new default is shadowed by `.env`) and the dashboard itself when the `dashboard` section changed.

The route never restarts anything itself.

### Applying

After a save the page offers "Apply: restart <units>". Applying restarts each unit in `restart` one after another through the existing lifecycle route, in its default mode and not isolated, so each restart is guarded, audited and holds the dashboard's one action slot like any other. A unit not running picks the change up at its next start. With control disabled the lifecycle routes do not exist; the page then says which units to restart and how (`cohostctl restart`).

The owner may save several sections and apply once.

## Lifecycle, health and pause

Start, stop and restart stay the control plane's: manifest-gated, one unit at a time, audited (control-plane, Runtimes and controller). The contract adds two things.

**Needs.** For each unit with `uses`, the health tracker lists in the unit's snapshot entry, as `needs`, every used unit whose derived state is `down`, `stale`, `crash-looping` or `unknown`. The unit's own derived state is unchanged: `needs` is an annotation beside it, and the Services row shows `needs <id> (<state>)`. Like the derived states, it is computed by each observer and never published, so no service reads the health stream.

**Pause and resume.** Each unit with `pause: true` gets Pause and Resume on its Services row, publishing `control { cmd: "pause" | "resume", target: <id> }` through `POST /control`. A service that honours `pause` reports it in its heartbeat `detail` (`paused`) through the shared control reader, so the row shows the real state rather than a page-local flag, and a restart (which starts unpaused) clears it. Units that never read `control` (the senses and the body) show no Pause; stopping them is the way to silence them.

## Test drawer

Each Services row opens a test drawer for that unit:

1. **Run isolated.** The existing isolated start (its preset and its `requires` closure). The presets make every declared input work with no account and no model server: eyes adds `VISION_ENGINE=stub` (a stub describer), ears `EARS_STT_ENGINE=stub` (a stub transcriber), mouth `MOUTH_DRYRUN_ENABLED=true` (a `dryrun` output that times each line and claims it as a sink, and can be told to give up on every n-th line to exercise the fallback line). Each stub is specified by its own segment (eyes EYES-STUB-*, ears EARS-STUB-*, mouth MOUTH-DRY-*).
2. **Inputs.** One form per declared input. Service-level kinds use the existing `POST /inject/text|image|audio`. Bus event types use `POST /inject/event { unit, type, data }`: the type must be one of the unit's declared inputs, `data` is validated against the bus schema, `injected: true` is set where the event schema has the flag, and the response is `202 { id }` with the bus id of the published event. Gated like the other inject routes. An injection for a unit whose derived state is `down` or `unknown` is refused `409` (`service not running: <unit>`), for the service-level routes too, so a test input never vanishes into a stopped consumer group.
3. **Feed.** The live feed filtered to the unit's `test.observe` types and its `inject.result`s.

No input needs a platform account or model server: chat's `fake` source, eyes' stub describer, ears' stub transcriber, voice's `stub` engine, mouth's `dryrun` output, avatar's `null` driver and the bus-level inputs all run on Redis alone.

An injected `brain.say` is a test input, not an operator `say`: it is published flagged `injected` straight to the services that consume `brain.say`, not through cortex. It exercises the body; it is not a way for the operator to make the co-host speak on stream, which stays cortex's operator `say` (HLD tenet 4).

## Page layout

```
┌──────────────────────────────────────────────────────────────┐
│ cohost  [stack: up]                    Feed │ Services │ Settings │ Viewers
├──────────────────────────────────────────────────────────────┤
│ Services                                                      │
│ cortex   up     live   3s   [Restart][Stop][Pause][Test ▾]    │
│ mouth    up  needs voice (down)  [Restart]…        [Test ▾]   │
├──────────────────────────────────────────────────────────────┤
│ Settings   section: [voice ▾]   read by: voice                │
│  engine     [kokoro ▾]  env-default (VOICE_ENGINE unset)      │
│  voice      [af_heart]  literal                               │
│  speed      [1.05    ]  literal                               │
│  [Validate] [Save]      Saved. Apply: restart voice [Apply]   │
└──────────────────────────────────────────────────────────────┘
```

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
|----------|--------|------------------------|-----------|
| Node shape | One leaf owning the contract's rules, beside control-plane, config and dashboard, which implement them | A sub-HLD over child leaves (editor, lifecycle, test surface); spreading the rules across the three implementing segments | The contract is a concern that spans components and carries its own decisions (one editor, restart-to-apply, manifest as the one list), so it is its own node. Its parts are facets of one intent, not separate intents: a sub-HLD would be a table of contents. Spread across three segments, no doc would say what a service must do to be finished. |
| Manifest as the single source of service lists | `SERVICE_MANIFEST` carries every per-service declaration; the tracker's known list, the page's unit list and the CLI derive from it; the page fetches it | Keep `KNOWN_SERVICES` and the page's `UNITS` by hand, tied by tests; generate the Compose file from the manifest | Hand-kept lists drifted once already and each new service touched three files. A served list removes the page's copy entirely. Generating Compose would move deployment detail (images, volumes, profiles) into the manifest; a two-way test is enough. |
| Settings editor | One generic editor generated from the zod schema | A page per service; editing raw YAML text in a textarea | A generated form cannot drift from the loader's rules and needs no change when a key is added. A raw-text editor loses the per-key source and secret handling and accepts unparsable text. |
| Schema to the browser | JSON Schema generated on the server from the zod schema | Ship zod and the schema module to the page; hand-written form descriptors | The page has no build step and no framework; JSON Schema is plain data a small renderer can walk. The generator is a small walker over zod's type tree in `@cohost/config`, so no dependency is added and zod stays on 3.x (config LLD, Decisions & Alternatives). |
| Where edits are written | `config.yaml` in place, through the parsed document, keeping comments and placeholders | An overrides file merged on top; `.env` variables | One file the owner can read, diff and edit by hand. An overrides file would hide which value wins; writing `.env` would move behaviour into the secrets file (tenet 7). |
| Placeholder keys | `env-default` keys are edited by changing the default and warned when `.env` shadows it; `env` keys without a default and secrets are read-only | Replace the placeholder with a literal; make every placeholder key read-only | Replacing a placeholder silently cuts the `.env` and isolation-preset switch the example relies on; making them read-only would lock most backend choices (provider, engine, source), which are exactly what the owner wants to flip. Chosen by recommendation (owner to confirm). |
| Validation | The whole edited file through the loader's own pipeline | Validate only the edited section's sub-schema | Cross-section rules and substitution happen at file level; the services will load the whole file, so the whole file is what must pass. |
| Concurrent edits | Whole-file etag, `409` on mismatch | Last write wins; a lock file | The owner edits the file by hand too; an etag catches a hand edit or a second tab without a lock that a crashed dashboard could leave behind. |
| Apply | The page restarts the reading units through the lifecycle route after a save | `PUT` restarts them itself; live reload | Restarting through the lifecycle route keeps one action slot, one audit path and the control gate; separating save from apply lets the owner batch edits and choose when to bounce a service mid-stream. Live reload would add a reload path to every service (HLD Key Design Decisions, Applying an edited setting). |
| Dependents | A `needs` annotation derived by the observer from manifest `uses`; the unit's own derived state unchanged | Fold it into the derived state as `degraded`; each service watches its peers and reports them as heartbeat deps; no display | The unit's own heartbeat stays the truth about the unit, and the annotation says why a feature is missing without hiding whether the unit itself is healthy. A service reading the health stream would couple services through health. Chosen by recommendation (owner to confirm). |
| Pause state | Reported by the paused service in its heartbeat detail | A page-local flag like today's mute; a new event | The page must show the real state after a restart or from a second tab; the heartbeat already carries a free-text detail every observer reads. |
| Bus-level test inputs | `POST /inject/event` limited to the unit's declared types, schema-validated, flagged `injected` where the schema allows | Free-form publishing of any event type; a route per event type | Declared types keep the page generic while stopping it from publishing heartbeats, lifecycle records or viewer-note events. |
| Docker Engine API vs CLI | Keep the `docker compose` CLI (recommended) | The Docker Engine API over the socket | Compose's project model (profiles, `COMPOSE_FILE`, dependency order, recreate on config change) lives in the CLI, not the Engine API, which knows only containers; the API would mean reimplementing Compose. The CLI runs with the owner's own Docker access and works through `docker.exe` on WSL2 without exposing a socket. The cost is parsing CLI output, which the stack controller already does defensively. Revisit only if Compose output parsing becomes a source of defects. |
| Injection to a stopped unit | Refused `409 service not running: <unit>` when the unit's derived state is `down` or `unknown` | Publish anyway | A `latest` consumer group skips what arrived while the service was down, so the injection would vanish with no result. Chosen by recommendation (owner to confirm). |
| Injected `brain.say` | A test input flagged `injected`, published to `brain.say` consumers directly; not an operator `say` | Route it through cortex as an operator `say`; refuse it | Testing voice, mouth and avatar must not need cortex; calling it an operator `say` would widen tenet 4's one override. Chosen by recommendation (owner to confirm). |
| Stubs for model-backed inputs | eyes stub describer, ears stub transcriber, mouth `dryrun` output, each in its isolation preset | Leave eyes and ears needing a model server; test mouth only with Discord | Obligation 3 promises a test input with no account; a vision model, a speech server or a Discord bot each break that. Owner decision. |
| Custom per-module forms | The page keeps a registry of renderers keyed by section path (`settingsForms`); none are registered, and a section without one gets the generic form | Build the first custom form now; no extension point | A module may later need a form the schema cannot express (a reflex list with a regex tester). The registry is the only change that costs nothing now and keeps the generic editor the default. |
| Apply after a failed restart | Continue with the remaining units and show each result | Stop at the first failure | Matches restart-all (control-plane CTRL-STACK-007); one bad unit should not leave the others on old settings. Chosen by recommendation. |
| Writing an absent key or section | A key is added under its section; a missing section is appended at the end of the file | Refuse to add keys | `mouth` is optional and most defaults are absent from the example; refusing would make defaulted keys uneditable. Chosen by recommendation. |
| Array values | The edit replaces the whole array | Per-element edits | The form edits an array as one value; per-element patches would need identity for elements that have none (fallback lines). Chosen by recommendation. |
| Validation environment | The settings editor validates with the dashboard's environment | Validate inside each container | A container sees Compose's `environment` overrides and, after an isolated start, a preset, so a value valid on the host can differ there; the services' own startup validation reports it. |
| Editing `expressions.yaml` | Not in the editor | Same editor | Read by avatar only; the editor could serve it later. |
| Undo | None | A history of saves | A saved section is restored by editing it back. |

| Where `needs` is computed | `withNeeds`, applied by the tracker's snapshot and again by the Compose overlay when it changes a state | Only in the tracker | The overlay can turn a silent unit into `crash-looping`, which its dependents must then list; recomputing from the overlaid snapshot keeps `needs` consistent with the states the page shows. |
| Entry-file check | An entry file passes when it calls `runService` or calls the one boot function of its unit whose module does, and builds no `Bus`, heartbeat or shutdown hook; a unit not yet moved is named in the test with its chunk | Require a literal `runService` call in every `index.ts`; skip units not yet moved | Several units keep a `run<Unit>()` boot function so their `main` is testable; a literal-call rule would force churn with no gain. Naming a pending unit keeps the gap visible until its chunk removes the name. Chosen by recommendation. |
| One-shots in the Compose check | A Compose service built from the shared Dockerfile belongs to the unit named by its `SERVICE` build argument | Require one unit per Compose service name | `consolidate` and `reembed` are one-shots of memory built with `SERVICE: memory`; they are not units. Chosen by recommendation. |
| Test button | A row shows it only for a unit that declares test inputs | Every manifest row | Infrastructure and model-server rows declare none, so there would be nothing in the drawer. |
| Sample payloads | The page keeps a sample payload per bus event type (not per unit) in the drawer's form, and a test checks each against its bus schema | Generate samples from the schema on the server; start every form empty | The page has no schema library; an empty form makes every test a typing exercise. A test keeps the samples valid. |

## Open Questions & Future Decisions

None.

## References

- HLD: System Design (Module contract); Key Design Decisions (Module contract, Applying an edited setting, Configuration split, Trust boundary); tenets 5, 6, 7.
- [shared-runtime](../shared-runtime/shared-runtime-design.md) (`runService`, `controlFor`, `startIdle`, `createInjectHandler`).
- [control-plane](../control-plane/control-plane-design.md) Service manifest, Runtimes and controller, HealthTracker.
- [config](../config/config-design.md) Loading pipeline, Schema, Decisions (Unknown keys, Caching).
- [dashboard](../dashboard/dashboard-design.md) HTTP surface, Test-input injection and uploads, The page.
- Code today: `packages/control/src/{manifest,health,cli}.ts`; `packages/config/src/{index,schema}.ts`; `services/dashboard/src/{routes,inject}.ts`, `public/index.html`.
