---
parent: high-level-design
prefix: MOD
---

# module-contract

Status: built: the manifest declarations and derived lists, needs, pause, the test side sheet, `POST /inject/event`, the isolated-stack run (MOD-TEST-007), the schema route and its presentation, and the editor's array, dry-run, answer and override behaviour (the `[x]` lines of MOD-CFG-001 to MOD-CFG-022); specified and not yet built: the editor over the settings store (the `[ ]` lines of MOD-CFG-003 to MOD-CFG-017), the manifest's `documents` and `stateKey` (MOD-MAN-016, MOD-MAN-017) and the contract test against the seed (MOD-MAN-011) ([module-contract-specs.md](module-contract-specs.md)). Parent: [high-level-design](../../high-level-design.md) (System Design: Module contract). Sibling: [shared-runtime](../shared-runtime/shared-runtime-design.md), which fulfils obligation 4. Implemented across [control-plane](../control-plane/control-plane-design.md) (the manifest and controller), [config](../config/config-design.md) (schema export and section editing) and [dashboard](../dashboard/dashboard-design.md) (routes and the Settings screen); this segment owns the rules those pieces follow together.

## Context and Design Philosophy

cohost has twelve application services, and the owner operates each of them in the same few ways: change its settings, start, stop or restart it, see whether it is healthy, and feed it a test input without a live stream. Before this contract each of those was partly there and partly special-cased: settings were edited by hand only, the dashboard and the health tracker each kept a list of services by hand, pause existed on the bus with no button, and only three services took a test input from the page.

The contract makes those four abilities obligations of every service, and makes the control plane's manifest the one place a service declares how it meets them. The dashboard and `cohostctl` read the declarations and need no per-service code.

Guiding rules:

- **Declare, do not special-case.** A service's settings sections, the services it uses, whether it honours `pause`, and its test inputs are fields of its manifest entry. A page or CLI branch on a service id is a defect.
- **The schema is the form.** The settings editor renders, validates and writes from the config schema the loader already enforces; nothing describes a setting twice.
- **One store, one write.** The settings store ([settings-store](../settings-store/settings-store-design.md)) is the source of truth for every operator setting; the editor changes a section through the store's one write operation (settings-store STORE-SET-001), which validates the whole configuration in the same transaction, and every stored key is a plain value, so an edit never depends on how a key was stored. The editor never reads or writes `.env`, and a credential reaches the store only through the dashboard's write-only secret route (`PUT /secrets/:path`).
- **The screen names itself.** Section titles, groups, one-sentence descriptions and every key's help come from the presentation table the schema route serves ([config](../config/config-design.md), Presentation table); the page holds no section name and no help text, and a setting that lacks them fails a build.
- **Restart is the apply.** A saved setting takes effect when the services that read it restart; no service learns to reload its configuration live. A unit running with an isolation override (`COHOST_ISOLATION`) reads its override until it is started again without one.

## The four obligations

A service meets the contract when all four hold:

| Obligation | Met by | Checked by |
|---|---|---|
| 1. Configurable from the dashboard | Its manifest entry names every settings section and document it reads | A test that every section a service reads (by its config type usage) is declared, and every declared path exists in the schema |
| 2. Independently operable | A manifest unit with a Compose service and a heartbeat; it keeps running when a service it uses is stopped (tenet 5) | Control-plane specs; a test that every application unit has a Compose service and every Compose application service a unit |
| 3. Test-injectable with no platform account | An isolation preset (tenet 6) and at least one declared test input | A test that every application unit declares a test input whose event type exists in the bus registry |
| 4. Built on the shared runtime | Its entry point is `runService`; it uses the shared module for every concern the shared runtime covers | Review; a test that each service's entry file calls `runService` |

## Example service

The docs site's Add a TypeScript service page teaches the four obligations with a complete service a reader can run before they change the repository: `examples/service/now-playing.ts`, a small sense that watches a text file (the "now playing" file many streaming setups write) and tells the co-host when the song changes (MOD-EX-001 to MOD-EX-005).

- **Built on the shared runtime from the first line.** Its entry calls `runService`; its logic is `nowPlayingMain(ctx, opts)`, so the test drives it with a fake bus and the runtime's seams, as the services' own tests do.
- **Uses an existing event type.** It publishes `vision.summary`, which salience and cortex already read as something the co-host noticed, and reads `brain.say`. A new event type is one entry in `packages/bus/src/events.ts`, which the page describes in prose; an example that needed one would have to change the bus to run.
- **Reports its own dependency.** `deps.file` is `down` while the file cannot be read, so the Services screen shows the service `degraded` with the reason, the way a real service reports a missing account.
- **Becomes a module in the page's later steps.** As an example it has no manifest entry and no Compose service, so it meets obligation 4 and not 1 to 3. The page walks the rest, naming each file: a folder under `services/`, its `package.json` and `tsconfig.json`, an entry in `packages/control/src/manifest.ts` (config sections, uses, `pause`, a test input), its Compose service, and the root `tsconfig.json` reference. Those edits are prose on the page, because the files they touch belong to control-plane, deployment and the build.

The file is in the examples TypeScript project, which `tsc -p examples/tsconfig.json` checks during `mise run test` (docs-site DOCS-GUIDE-025); `packages/testing/test/example-service.test.ts` runs it.

## Service descriptor (manifest)

Each application unit in `SERVICE_MANIFEST` carries, beside its existing fields (`groups`, `defaultMode`, `infra`, `requires`, `isolatedEnv`):

| Field | Meaning |
|---|---|
| `config` | Dotted schema paths of the sections the service reads (`voice`, `brain.salience`, `llm`); every application unit lists `logging`, which every cohost program's logger reads. The unit's projection holds exactly these sections, and reading any other section throws (settings-store STORE-PROJ-001, config CFG-LOAD-001) |
| `documents` | Which of the stored documents `personality` and `expressions` the service reads: `cortex` and `memory` read `personality`, `avatar` reads `expressions`, every other unit none (MOD-MAN-016). The projection carries exactly these, and a unit whose source loads a document its list lacks fails a test |
| `secrets` | The secret paths the service reads (paths of `SECRET_PATHS`, the wildcard `tools.servers.*.token` included), each inside a section its `config` names; the control plane's credentials message to the unit carries exactly these, the ones the store holds, and no other credential reaches it (settings-store STORE-DLV-002, STORE-DLV-008). Empty when the unit reads none, and a unit with no secret path and no state key receives no message |
| `stateKey` | Whether the unit persists a credential it obtains at run time and so receives a per-unit state key in its message to encrypt it: true for `chat` (the refreshed Twitch token) and `avatar` (the VTube Studio plugin token), false for every other unit (MOD-MAN-017, settings-store STORE-STATE-001) |
| `uses` | Services whose absence degrades one of this service's features (cortex uses salience, affect, memory, tools; tools uses memory; mouth uses voice); `requires` stays the subset an isolated start brings up, and must be a subset |
| `pause` | Whether the service honours `pause` (salience, cortex, affect) |
| `test.inputs` | The inputs the dashboard may feed it: service-level injection kinds (`text`, `image`, `audio`) or bus event types |
| `test.observe` | The event types that show its reaction, for the filtered feed |

The manifest is the one list of services. Everything else derives from it:

- the health tracker's known services (application units);
- the page's unit list, served by `GET /services/manifest` (ungated, like `GET /services`) instead of a constant in the page;
- `cohostctl status`'s list;
- the settings editor's section-to-service map;
- the test side sheet's inputs and feed filter.

The Compose file stays hand-written; a test ties it to the manifest in both directions.

Initial declarations (the `config` and `uses` values are the owning segments' to confirm in Phase 3):

| Unit | `config` | `uses` | `pause` | `test.inputs` | `test.observe` |
|---|---|---|---|---|---|
| chat | `chat`, `viewer_text`, `cohost` | | no | `text` (service) | `chat.message`, `inject.result` |
| eyes | `vision`, `llm`, `network` | | no | `image` (service) | `vision.summary`, `inject.result` |
| ears | `ears`, `network` | | no | `audio` (service) | `speech.heard`, `inject.result` |
| salience | `brain.salience`, `brain.cortex`, `brain.working_memory_events`, `brain.working_memory_own_lines`, `brain.input_limits`, `viewer_text`, `cohost`, `llm`, `tools` | affect, cortex | yes | `chat.message`, `speech.heard`, `vision.summary` | `attention.focus`, `brain.say` |
| affect | `brain.affect`, `brain.input_limits`, `viewer_text`, `cohost`, `llm` | | yes | `chat.message`, `speech.heard`, `vision.summary`, `brain.say` | `affect.state` |
| memory | `brain.memory`, `brain.input_limits`, `viewer_text`, `cohost`, `llm` | | no | `chat.message`, `memory.recall.request` | `memory.recall.reply`, `memory.viewer` |
| cortex | `brain.cortex`, `brain.memory`, `brain.salience`, `brain.working_memory_events`, `brain.working_memory_own_lines`, `brain.input_limits`, `viewer_text`, `cohost`, `llm`, `tools` | salience, affect, memory, tools | yes | `attention.focus` | `brain.status`, `brain.say` |
| tools | `tools`, `cohost`, `chat`, `viewer_text`, `network` | memory | no | `text` (service; target `tools`, a JSON object naming the tool and its arguments) | `tool.result`, `inject.result` |
| voice | `voice`, `network` | | no | `brain.say` | `voice.utterance`, `voice.playing`, `voice.done` |
| mouth | `mouth` | voice | no | `brain.say` (through voice) | `voice.playing`, `voice.done`, `voice.failed` |
| avatar | `avatar` | voice | no | `brain.say`, `affect.state` | `avatar.state` |
| connector-discord | `connections` | | no | `audio` (service; target `connector-discord`) | `inject.result` |

Initial `secrets` declarations, checked against the credentials each service's code reads (`tools`' list is its segment's, TOOL-SVC-010). `eyes` describes frames through the chat-model layer with the `llm` credentials (`vision.provider` `openai`, `anthropic` or `bedrock`), and `salience` and `affect` run their hook modules through the same layer, so each declares the `llm` keys; `voice` reads only its OpenAI-compatible key, because the Pocket token reaches only the engine container. The list is explicit, not every secret under the unit's sections: `salience` and `cortex` read the `tools` section and use no MCP token, and `tools` reads `chat` and uses no chat user token.

| Unit | `secrets` |
|---|---|
| chat | `chat.twitch.client_id`, `chat.twitch.client_secret`, `chat.twitch.access_token`, `chat.twitch.refresh_token`, `chat.youtube.api_key` |
| eyes | `vision.obs.password`, `llm.openai.api_key`, `llm.claude.api_key`, `llm.bedrock.access_key_id`, `llm.bedrock.secret_access_key` |
| ears | `ears.openai.api_key`, `ears.nemotron.api_key`, `ears.kyutai.api_key` (plus the derived listener key the control plane adds to its delivery, not a declared path, config CFG-SEC-020) |
| salience, affect, memory, cortex | `llm.openai.api_key`, `llm.claude.api_key`, `llm.bedrock.access_key_id`, `llm.bedrock.secret_access_key` |
| tools | `tools.servers.*.token`, `chat.twitch.client_id`, `chat.twitch.client_secret`, `chat.youtube.api_key` |
| voice | `voice.openai.api_key` |
| connector-discord | `connections.discord.token` |
| mouth, avatar | none |

`voice.pocket.hf_token` is declared by no unit: it reaches only the `tts-pocket` engine container, which the control plane hands that one value alone (settings-store STORE-DLV-006; deployment Speech engine servers).

The `dashboard` section is read by the dashboard itself, which is not a unit: it applies on the dashboard's next start. The `renderer` section (the browser renderer's model and framing) is read by the dashboard alone as well, and declared by no unit, but the dashboard applies a save of it at once and restarts nothing ([dashboard](../dashboard/dashboard-design.md) Avatar settings; the presentation table marks it `live`).

The optional engine servers (`tts-pocket`, `stt-nemotron`, `stt-kyutai`, each behind a Compose profile) are compose-only units with no descriptor fields: the Services screen lists them and the two-way test between the Compose file and the manifest covers them, and no unit lists one in `uses`, because a profile that is not enabled leaves the unit `unknown` and the `needs` annotation would then name a server nobody asked for. The dependency of `voice` and `ears` on the engine they selected is their own `deps.tts` and `deps.stt`. Launch starts whichever profiles `COMPOSE_PROFILES` names, and the stack card shows a first build and a first weights download as ordinary starting phases and not-ready services ([deployment](../deployment/deployment-design.md) Speech engine servers).

## Settings editor

### Routes (dashboard)

| Route | Gated | Behaviour |
|---|---|---|
| `GET /config/schema` | no | `{ groups, sections: [{ path, title, group, about, page?, services, schema, secrets, keys }] }`: the ordered group names, every declared section with its plain name, group, one-sentence description and optional host screen, the services that read it, its JSON Schema generated from the zod schema, the names of its secret keys, and the presentation of each key (below) |
| `GET /config/:section` | no | `{ section, etag, keys, unknown }` (below) |
| `PUT /config/:section` | yes, like every mutation (dashboard DASH-CTRL-004), a change to a `sensitive` key included | Validate and write; `?dryRun=1` validates and writes nothing and is never gated |

`:section` is a declared dotted path; anything else is `404`. Bodies are capped at 64 KiB like the other JSON routes.

### Presentation served with the schema

Each section entry carries its `title`, `group` (one of `groups`), `about` and, where the table gives one, `page`: another section's path whose screen shows this one (`brain.working_memory_events` is shown on `brain.memory`). It also carries `keys`, a map from each key's relative name (the names `GET /config/:section` uses, so a leaf section such as `brain.working_memory_events` has the one key `working_memory_events`) to:

| Field | Meaning |
|---|---|
| `help` | One sentence for the operator; present for every key. It is also the key's JSON Schema `description` |
| `label` | Display name where the key name is not plain; the page falls back to the key name |
| `unit` | `ms`, `bytes`, `days` and the like, shown beside the input |
| `sensitive` | `true` on a key that decides where a credential or the co-host's private context goes (config CFG-PRES-011); the page shows a warning beside it, and a save that changes it is gated like any other (dashboard DASH-SET-028) |
| `items` | For an array of objects, a map from each item property to `{ help, label?, unit? }` |
| `widget` | A hint from a closed set: `{ type: "timezone" }`, `{ type: "voice" }`, `{ type: "sources" }`, `{ type: "textarea" }`, `{ type: "model", kind: chat \| small \| vision \| embed \| stt }`, `{ type: "options", options: [{ value, label }] }`, `{ type: "mcp-servers" }`, `{ type: "tool-list" }` |

The Settings screen renders a key with the widget it names, or the generic control for its JSON Schema type when there is none ([dashboard](../dashboard/dashboard-design.md), Settings screen). The schema route serves no list of models or voices: the `model` and `voice` widgets take theirs from the dashboard's pick-list routes, `GET /options/models` and `GET /options/voices` (DASH-OPT-001 to DASH-OPT-004), and a free-text entry stays possible. An array of objects also carries `items`, the help of each item property. The table is data in `@cohost/config`, checked for completeness at build time (config CFG-PRES-007), so the answer never has a key without help.

### Reading a section

`etag` is the settings store's revision, `meta.revision`, which every committed write to the store increments (settings-store STORE-DB-006; MOD-CFG-003). It is one number for the whole store, so every section read at the same moment answers the same etag, and any write, of any section, a credential or the personality included, changes it for everyone. For each key in the section, `keys` gives (MOD-CFG-004):

| Field | Meaning |
|---|---|
| `value` | The value the services read when started without isolation: the stored value, or the schema default. Absent for a secret |
| `source` | `literal` (the section's stored document holds the key) or `default` (it does not; the schema default applies) |
| `isolation` | For a key that an isolation override selects (config CFG-ISO-006): `{ name, overriddenBy }`, the override's name and the ids of the running units whose container was started with it, which is how an isolated start shows up (below) |
| `raw` | The stored value written as YAML, for a `literal` key |
| `editable` | true for every key except a secret |

`unknown` lists the dotted paths of keys the section's stored document holds that the schema does not define (MOD-CFG-006): a key a later schema dropped or renamed, or one brought in by an import. The services never see such a key's value, and the editor keeps it until a `PUT` names it in `remove`.

A key is a scalar or an array (arrays of objects included) under the section, named by its dotted path relative to the section (`openai.api_key` in `llm`); a section that is itself a scalar (`brain.working_memory_events`) has one key named for its last path segment. `unknown` carries dotted paths from the configuration's root (`brain.salience.reflexes[0].cooldwn_ms`).

Secrets (the schema marks them; the paths of config CFG-SEC-003) are never returned, only whether they are set (`secret: true`, `set`: whether the store's `secrets` table holds a row at that path; MOD-CFG-005). A wildcard path (`tools.servers.*.token`) is reported once per server the stored `tools.servers` map holds, as `servers.<name>.token`. No `/config/*` response, an error message included, carries a secret's value or a hash of one (MOD-CFG-017); the `etag` is the revision, which says nothing about any value. Credentials live encrypted in the store (tenet 7) and are not editable here: a `PUT` that names a secret key is refused, and credentials are written only through a gated, write-only secret route that belongs to the [dashboard](../dashboard/dashboard-design.md) segment.

**Overridden keys.** An isolated start gives one unit's container a `COHOST_ISOLATION` carrying override names and values (control-plane, Isolated starts); the control plane's stack status reports, per running unit, which overrides its container was started with (control-plane CTRL-STACK-016). For a key that an override selects, `GET /config/:section` lists in `isolation.overriddenBy` the units that declare the section and run with that override, so the screen can say that a unit is running an isolated override instead of presenting a shadow nobody set. An edit to such a key changes the stored section as usual; the saved value applies again once the unit is started without isolation, and a unit running with the override reads the override until then, because `docker compose restart` keeps the container's environment.

### Writing a section

`PUT` takes `{ etag, values, remove? }`, where `values` maps keys of the section to new values and `remove`, optional, lists dotted paths under the section whose stored keys are removed (MOD-CFG-009). The edit is one call of the store's write operation (settings-store STORE-SET-001), which runs as one `BEGIN IMMEDIATE` transaction (STORE-SET-002):

1. A key in `values` that is not editable (a secret) or not in the section's schema is `400 { ok: false, issues }` naming it, and nothing is written (MOD-CFG-009). A path in `remove` may name a key the schema does not define, which is how an `unknown` key goes.
2. Inside the transaction, `etag` must equal `meta.revision`, else `409 { ok: false, etag }` with the current revision, and nothing is written (MOD-CFG-008, settings-store STORE-SET-003). The comparison and the write cannot interleave with another writer, the dashboard's other routes, `cohostctl` or a `config:*` task alike.
3. Each value of `values` is set in the section's stored document whatever the key's `source`, an array replacing the whole array (MOD-CFG-011); each path of `remove` is deleted from it, so the schema default applies or the unknown key is gone. Every other key of the section, every other section and every unknown key the request does not remove are unchanged, and a section the store does not hold yet is added (MOD-CFG-010).
4. The whole configuration assembled from the stored sections, with the edit applied, runs through the placeholder check (config CFG-ENV-011), null dropping and `ConfigSchema`, with no isolation override applied (MOD-CFG-012). Issues roll the transaction back and answer `400 { ok: false, issues: [{ path, message }] }`. Stored settings that already fail the schema (config recovery) therefore accept only an edit that makes them valid.
5. With `?dryRun=1` the route stops here and rolls back: `200 { ok: true, dryRun: true, warnings }` (MOD-CFG-013).
6. The transaction increments `meta.revision` and commits; a write that fails (the store busy past its timeout, a disk error) is `500` with the error text and leaves the store unchanged (MOD-CFG-014).
7. `200 { ok: true, etag, restart, warnings }`, `etag` the new revision: `restart` lists the units that read the section and that the latest stack status shows running (none for `renderer`, which no unit reads); `warnings` names each edited key a running unit overrides (`isolation.overriddenBy` is non-empty) and, when the `dashboard` section changed, that the change applies at the dashboard's next start, with, for a changed `dashboard.port` or `dashboard.lan_port`, that the page address changes to the new port (MOD-CFG-015). A dry run (step 5) returns the same warnings.

The store holds each section as a sparse JSON document of the keys the owner set, so there is no text to splice and nothing about layout or comments to keep: a key's value is the whole of what is stored for it. The route never restarts anything itself, never writes a credential and never touches `.env` (MOD-CFG-016).

### Applying

After a save the Settings screen offers to restart the units in `restart` ([dashboard](../dashboard/dashboard-design.md), DASH-SET-007, DASH-SET-008). Each restart goes through the existing lifecycle route, in its default mode and not isolated, so it is guarded, audited and holds the dashboard's one action slot like any other. Before it restarts the container, the control plane rewrites every unit's projection from the store and, after it, delivers the unit's credentials (settings-store STORE-PROJ-003, STORE-DLV-003), so the restarted unit reads the saved section. A unit not running picks the change up at its next start, which writes its projection the same way.

The owner may save several sections and apply once.

## Lifecycle, health and pause

Start, stop and restart stay the control plane's: manifest-gated, one unit at a time, audited (control-plane, Runtimes and controller). The contract adds two things.

**Needs.** For each unit with `uses`, the health tracker lists in the unit's snapshot entry, as `needs`, every used unit whose derived state is `down`, `stale`, `crash-looping` or `unknown`. The unit's own derived state is unchanged: `needs` is an annotation beside it, and the Services row shows `needs <id> (<state>)`. Like the derived states, it is computed by each observer and never published, so no service reads the health stream.

**Pause and resume.** Each unit with `pause: true` gets one control on its Services row, Pause while it runs and Resume while it is paused, publishing `control { cmd: "pause" | "resume", target: <id> }` through `POST /control`. A service that honours `pause` reports it in its heartbeat `detail` (`paused`) through the shared control reader, so the row shows the real state rather than a page-local flag, and a restart (which starts unpaused) clears it. Units that honour no `pause` (the senses and the body; mouth reads `control` only for `set_routing`) show no Pause; stopping them is the way to silence them.

## Test side sheet

Each Services row opens a test panel for that unit (a side sheet in the React UI):

1. **Run isolated.** The existing isolated start (its preset and its `requires` closure). The presets make every declared input work with no account and no model server: eyes adds `VISION_PROVIDER=stub` (a stub describer), ears `EARS_STT_ENGINE=stub` (a stub transcriber), mouth `MOUTH_DRYRUN_ENABLED=true` (a `dryrun` output that times each line and claims it as a sink, and can be told to give up on every n-th line to exercise the fallback line). Each stub is specified by its own segment (eyes EYES-STUB-*, ears EARS-STUB-*, mouth MOUTH-DRY-*).
2. **Inputs.** One form per declared input. Service-level kinds use the existing `POST /inject/text|image|audio`; the side sheet names the unit as the `target` of an audio injection (`ears` or `connector-discord`) and of a text injection (`chat`, or `tools`, whose text is the JSON of one tool call; [tools](../tools/tools-design.md) Test injection). Bus event types use `POST /inject/event { unit, type, data }`: the type must be one of the unit's declared inputs, `data` is validated against the bus schema, `injected: true` is set where the event schema has the flag, and the response is `202 { id }` with the bus id of the published event. Gated like the other inject routes. An injection for a unit whose derived state is `down` or `unknown` is refused `409` (`service not running: <unit>`), for the service-level routes too, so a test input never vanishes into a stopped consumer group.
3. **Feed.** The live feed filtered to the unit's `test.observe` types and its `inject.result`s.

No input needs a platform account or model server: chat's `fake` source, eyes' stub describer, ears' stub transcriber, voice's `stub` engine, mouth's `dryrun` output, avatar's `null` driver and the bus-level inputs all run on Redis alone.

An injected `brain.say` is a test input, not an operator `say`: it is published flagged `injected` straight to the services that consume `brain.say`, not through cortex. It exercises the body; it is not a way for the operator to make the co-host speak on stream, which stays cortex's operator `say` (HLD tenet 4).

## Page

The Services screen, its test side sheet and the Settings screen are the dashboard's ([dashboard](../dashboard/dashboard-design.md), The UI; DASH-UI-*, DASH-SET-*); this segment states only what they must show: needs, pause and the declared inputs above, and each key's source, secret state and override.

## Decisions & Alternatives

| Decision | Chosen | Alternatives Considered | Rationale |
|----------|--------|------------------------|-----------|
| Example service | A file-watching sense in `examples/service/` on `runService`, publishing an existing event type, tested with the fake bus; the steps that make it a full module are prose on the docs site | A new service added to `services/` and the manifest as the example; an example with its own event type | A shipped example service would be a unit in every stack, with a Compose service and a manifest entry nobody runs. A new event type would make the example a change to the bus. An out-of-tree file the reader copies keeps the repository's units real and the example compiled and tested. |
| Node shape | One leaf owning the contract's rules, beside control-plane, config and dashboard, which implement them | A sub-HLD over child leaves (editor, lifecycle, test surface); spreading the rules across the three implementing segments | The contract is a concern that spans components and carries its own decisions (one editor, restart-to-apply, manifest as the one list), so it is its own node. Its parts are facets of one intent, not separate intents: a sub-HLD would be a table of contents. Spread across three segments, no doc would say what a service must do to be finished. |
| Manifest as the single source of service lists | `SERVICE_MANIFEST` carries every per-service declaration; the tracker's known list, the page's unit list and the CLI derive from it; the page fetches it | Keep `KNOWN_SERVICES` and the page's `UNITS` by hand, tied by tests; generate the Compose file from the manifest | Hand-kept lists drifted once already and each new service touched three files. A served list removes the page's copy entirely. Generating Compose would move deployment detail (images, volumes, profiles) into the manifest; a two-way test is enough. |
| Settings editor | One generic editor generated from the zod schema | A page per service; editing raw YAML text in a textarea | A generated form cannot drift from the loader's rules and needs no change when a key is added. A raw-text editor loses the per-key source and secret handling and accepts unparsable text. |
| Schema to the browser | JSON Schema generated on the server from the zod schema | Ship zod and the schema module to the page; hand-written form descriptors | JSON Schema is plain data a generic renderer can walk, and the browser needs no zod. The generator is a small walker over zod's type tree in `@cohost/config`, so no dependency is added (config LLD, Decisions & Alternatives). |
| Where edits are written | The section's document in the settings store, through the store's one write operation, in one transaction that validates the whole configuration (settings-store STORE-SET-001, STORE-SET-002) | `config.yaml` edited in place, splicing the value into the text to keep comments; an overrides file for ordinary settings merged on top; `.env` variables; Redis | Owner decision (#372): one place with transactions, one backup and one export, and no file edited by hand ([config in one place](../../decisions/config-in-one-place.md)). A transaction makes the etag check, the validation and the write one step that no other writer can interleave with, which a text file shared with a hand editor cannot give, and a stored document has no comments or layout for an edit to disturb. An overrides file would hide which value wins; `.env` reaches a container only when Compose creates it, so a restart would not apply an edit; Redis here has no auth and can lose 60 s of edits, and `consolidate` and `reembed` never open the bus. A restart applies an edit because the control plane writes the unit's projection from the store before every start (settings-store STORE-PROJ-003). |
| Overridden keys | Every stored key is a plain value, so every non-secret key is editable the same way; a key a running unit overrides is reported (`isolation.overriddenBy`) and stays editable, and a secret is read-only | Keep the isolation switch as a `${VAR}` placeholder in the settings and edit its default; make the overridden keys read-only | The override travels in `COHOST_ISOLATION` and is applied by key path (config CFG-ISO-007), so the settings never need a placeholder and the backend choices (provider, engine, source), which the owner wants to edit, are plain keys. A write that holds a `${VAR}` placeholder is refused (config CFG-ENV-011), so no operator setting is hidden behind one. |
| Validation | The whole configuration assembled from the stored sections, with the edit applied, through the loader's own checks (placeholder refusal, null dropping, `ConfigSchema`) inside the write's transaction | Validate only the edited section's sub-schema | Cross-section rules hold across sections, and every unit's projection is cut from the same stored configuration, so the whole configuration is what must pass. |
| Concurrent edits | The store's revision as the etag, compared inside the write's transaction, `409` on mismatch | Last write wins; a lock file; a per-section revision | Several programs write the store (the dashboard, the `config:*` tasks, an import, a restore); one revision catches any of them and a second tab without a lock that a crashed dashboard could leave behind. A per-section revision would let a save pass over a change to another section that the cross-section validation depends on; the cost of one revision is a `409` after an unrelated write, which the Settings screen handles by taking the etag each write answers (DASH-SET-031). |
| Apply | The Settings screen restarts the reading units through the lifecycle route after a save | `PUT` restarts them itself; live reload | Restarting through the lifecycle route keeps one action slot, one audit path and the control gate; separating save from apply lets the owner batch edits and choose when to bounce a service mid-stream. Live reload would add a reload path to every service (HLD Key Design Decisions, Applying an edited setting). |
| Dependents | A `needs` annotation derived by the observer from manifest `uses`; the unit's own derived state unchanged | Fold it into the derived state as `degraded`; each service watches its peers and reports them as heartbeat deps; no display | The unit's own heartbeat stays the truth about the unit, and the annotation says why a feature is missing without hiding whether the unit itself is healthy. A service reading the health stream would couple services through health. Chosen by recommendation (owner to confirm). |
| Pause state | Reported by the paused service in its heartbeat detail | A page-local flag for the mute state; a new event | The page must show the real state after a restart or from a second tab; the heartbeat already carries a free-text detail every observer reads. |
| Bus-level test inputs | `POST /inject/event` limited to the unit's declared types, schema-validated, flagged `injected` where the schema allows | Free-form publishing of any event type; a route per event type | Declared types keep the page generic while stopping it from publishing heartbeats, lifecycle records or viewer-note events. |
| Docker Engine API vs CLI | Keep the `docker compose` CLI (recommended) | The Docker Engine API over the socket | Compose's project model (profiles, `COMPOSE_FILE`, dependency order, recreate on config change) lives in the CLI, not the Engine API, which knows only containers; the API would mean reimplementing Compose. The CLI runs with the owner's own Docker access and works through `docker.exe` on WSL2 without exposing a socket. The cost is parsing CLI output, which the stack controller already does defensively. Revisit only if Compose output parsing becomes a source of defects. |
| Injection to a stopped unit | Refused `409 service not running: <unit>` when the unit's derived state is `down` or `unknown` | Publish anyway | A `latest` consumer group skips what arrived while the service was down, so the injection would vanish with no result. Chosen by recommendation (owner to confirm). |
| Injected `brain.say` | A test input flagged `injected`, published to `brain.say` consumers directly; not an operator `say` | Route it through cortex as an operator `say`; refuse it | Testing voice, mouth and avatar must not need cortex; calling it an operator `say` would widen tenet 4's one override. Chosen by recommendation (owner to confirm). |
| Stubs for model-backed inputs | eyes stub describer, ears stub transcriber, mouth `dryrun` output, each in its isolation preset | Leave eyes and ears needing a model server; test mouth only with Discord | Obligation 3 promises a test input with no account; a vision model, a speech server or a Discord bot each break that. Owner decision. |
| Custom per-module forms | The Settings screen may keep a registry of renderers keyed by section path; none is specified, and a section without one gets the generic form | Build the first custom form now; no extension point | A module may later need a form the schema cannot express (a reflex list with a regex tester). The registry is the only change that costs nothing now and keeps the generic editor the default. |
| Apply after a failed restart | Continue with the remaining units and show each result | Stop at the first failure | Matches restart-all (control-plane CTRL-STACK-007); one bad unit should not leave the others on old settings. Chosen by recommendation. |
| Writing an absent key or section | A key is added to its section's stored document; a section the store does not hold gets a row | Refuse to add keys | `mouth` is optional and most defaults are absent from the seed; refusing would make defaulted keys uneditable. Chosen by recommendation. |
| Array values | The edit replaces the whole array | Per-element edits | The form edits an array as one value; per-element patches would need identity for elements that have none (fallback lines). Chosen by recommendation. |
| Validation environment | The settings editor validates the stored configuration alone, with no isolation override and no environment | Validate inside each container; validate with the dashboard's environment | A container applies `COHOST_ISOLATION` after an isolated start, so a value valid on the host can differ there; the services' own startup validation reports it. The environment decides no setting, so the dashboard's own adds nothing to validate. |
| Editing the `expressions` document | Not in the editor; changed by import (settings-store STORE-IO-004) | Same editor | Read by avatar only; the editor could serve it later. |
| Undo | None; the store's backups are the only history (settings-store Backups) | A history of saves | A saved section is restored by editing it back. |
| Where `needs` is computed | `withNeeds`, applied by the tracker's snapshot and again by the Compose overlay when it changes a state | Only in the tracker | The overlay can turn a silent unit into `crash-looping`, which its dependents must then list; recomputing from the overlaid snapshot keeps `needs` consistent with the states the page shows. |
| Entry-file check | An entry file passes when it calls `runService` or calls the one boot function of its unit whose module does, and builds no `Bus`, heartbeat or shutdown hook; a unit not yet moved is named in the test with its chunk | Require a literal `runService` call in every `index.ts`; skip units not yet moved | Several units keep a `run<Unit>()` boot function so their `main` is testable; a literal-call rule would force churn with no gain. Naming a pending unit keeps the gap visible until its chunk removes the name. Chosen by recommendation. |
| One-shots in the Compose check | A Compose service built from the shared Dockerfile belongs to the unit named by its `SERVICE` build argument | Require one unit per Compose service name | `consolidate` and `reembed` are one-shots of memory built with `SERVICE: memory`; they are not units. Chosen by recommendation. |
| Test input of a connector unit (`connector-discord`) | An `audio` clip injected with target `connector-discord`, played on the connector's sink path; where Discord is off it plays against a player that sends nothing and the `inject.result` reports what it would have played | A frame the dashboard publishes on `audio.in.discord` (exercises ears, not the connector); exempting connector units from obligation 3 | Every unit meets the same obligation and is exercisable from the drawer with no platform account. The injected clip reuses the `audio` kind and its upload path and runs the connector's own conversion and playout (CONN-INJ-001 to 006). |
| Test input of `tools` | A `text` injection with target `tools` whose text is the JSON of one tool call; the answer is `ok` once the call ran through the pipeline and a `tool.result` was published, whatever its status | A bus event type (`tool.request`) as the input; no test input | The service has no sense or sink to feed, and injecting a request through the real pipeline exercises the allow-list, origin and timeout checks. A refusal is an answer, so a default configuration with no tool enabled still answers its test input and an isolated start passes (MOD-TEST-001). |
| Test button | A row shows it only for a unit that declares test inputs | Every manifest row | Infrastructure and model-server rows declare none, so there would be nothing in the side sheet. |
| Answer to an injection (MOD-TEST-007) | Re-send until a per-unit deadline, observing each attempt for a bounded window; cortex's re-sends wait until its newest `brain.status` is not `speaking` | Stop background chat traffic for the run; one 30 s observation per unit | Fake chat traffic keeps cortex's voice-busy gate closed about a third of the time, so a single injection is dropped by design; the stack stays as shipped and the test proves each unit answers once its gate allows it. |
| Sample payloads | The page keeps a sample payload per bus event type (not per unit) in the side sheet's form, and a test checks each against its bus schema | Generate samples from the schema on the server; start every form empty | The page has no schema library; an empty form makes every test a typing exercise. A test keeps the samples valid. |
| Per-unit contract tests | One dashboard-handler test table driven from `SERVICE_MANIFEST` (settings, isolated restart, each declared input and its not-running refusal) plus one thin `contract.test.ts` per service calling a shared `@cohost/testing` helper (entry reaches `runService`, declared sections validate the example) | A live-stack run only (MOD-TEST-007); hand-written tests per unit | The live run needs Docker and proves answers, not the contract's edges (etag, 409, single-unit restart). A table over the manifest runs everywhere and fails the moment a new unit lacks a declaration the table needs; the helper keeps one copy of the entry check, shared with the derived-lists test. |
| Presentation beside the schema | The schema route serves a presentation table (title, group, about, per-key help, label, unit, widget) and the page holds none | Hard-code section names and help in the page; derive widgets from key names; put help only in zod `.describe()` | A page with its own section list drifts the moment a section is added; the table is checked at build time, so a new setting cannot ship unexplained. `keys` is a map beside the JSON Schema rather than `x-` extensions inside it, so the schema stays plain JSON Schema and the names match `GET /config/:section`. Widgets are a closed set the page implements once. |
| Where `help` travels | `keys[k].help`, also the JSON Schema `description` | Only one of the two | A renderer that reads only JSON Schema still shows help; both are generated from the one table entry, so they cannot differ. |
| How overrides are detected | The control plane reports the overrides each running container was started with, read from the `COHOST_ISOLATION` entry of the container's environment | The dashboard remembers which isolated starts it ran; read the dashboard's own environment | The container's environment is what the unit actually reads, and it survives a dashboard restart and a start from `cohostctl`; a remembered start is lost on restart and misses a start made elsewhere; the dashboard's environment does not hold the override at all. |
| Secrets on the editor's routes | Read as set or not set only; never written through `PUT /config/:section` | Return a masked value or its length; accept a secret in the same `PUT` | A mask, a length or a hash still discloses something to a page the owner may screen-share; the write-only route keeps one narrow, gated path for credentials with its own rules (dashboard segment). |
| Removing a stored key | `remove`, a list of dotted paths in the `PUT`, deletes each stored key it names, an unknown key included (MOD-CFG-009) | Remove a key by sending `null` in `values`; leave unknown keys until an import replaces the section; tell the owner to edit the store by hand | `null` already means "drop this value" to the loader's null-dropping, so overloading it in `values` would make a request's meaning depend on the key; a separate list says plainly what goes. No file is edited by hand, so an unknown key the editor could not remove would stay for good. |
| Unknown keys in a section | Kept, listed in `unknown`, and removed only when a `PUT` names them in `remove` (DASH-SET-033) | Drop them silently at the next write; refuse the write | A key the schema does not define is often a renamed or misspelt setting the owner wants to see before it goes; silent removal loses it, and refusing would block every save of the section on a key the services ignore anyway. |
| Documents in the manifest | A `documents` list per unit naming `personality` and `expressions` (MOD-MAN-016) | Project both documents to every unit; treat them as sections of `config` | Least privilege per unit (settings-store): only cortex and memory need the persona and only avatar the emotion map. They are not keys of `ConfigSchema`, so a `config` entry for them would not be a schema path. |
| State keys in the manifest | A `stateKey` flag per unit (MOD-MAN-017) | Give every unit a state key; derive it from the `secrets` list | Only `chat` and `avatar` persist a credential they obtain at run time; a key nobody uses is a key to rotate and deliver for nothing, and holding a secret path says nothing about writing one. |

## Open Questions & Future Decisions

- **Apply keeps an isolated override.** The Settings screen's restart banner restarts a unit in its default mode, which is `docker compose restart`; that keeps the container's environment, so a unit started isolated stays isolated after Apply. Decision wanted (control-plane and dashboard): should Apply recreate a unit whose `isolation.overriddenBy` is non-empty, or should the screen only warn (MOD-CFG-015).

## References

- HLD: System Design (Module contract); Key Design Decisions (Module contract, Applying an edited setting, Configuration split, Trust boundary); tenets 5, 6, 7.
- [shared-runtime](../shared-runtime/shared-runtime-design.md) (`runService`, `controlFor`, `startIdle`, `createInjectHandler`).
- [control-plane](../control-plane/control-plane-design.md) Service manifest, Runtimes and controller, HealthTracker.
- [config](../config/config-design.md) Loading pipeline, Presentation table, Schema, Decisions (Unknown keys, Caching); [settings-store](../settings-store/settings-store-design.md) (the store's one write, the revision, projections, the credentials message, state keys); [config in one place](../../decisions/config-in-one-place.md).
- [dashboard](../dashboard/dashboard-design.md) HTTP surface, Test-input injection and uploads, The UI, Settings screen.
- Example: `examples/service/now-playing.ts`, `examples/service/README.md`, `packages/testing/test/example-service.test.ts`; the docs site's Add a TypeScript service page (`docs/advanced/extend/typescript-service.md`) and Ways to extend cohost import it.
- Code: `packages/control/src/{manifest,health}.ts`; `packages/config/src/{index,schema,editor,pipeline}.ts`; `services/dashboard/src/{routes,inject,settings}.ts`, `services/dashboard/ui/`.
