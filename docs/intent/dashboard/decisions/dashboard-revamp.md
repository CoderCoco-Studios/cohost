# Dashboard revamp

Decision record for rebuilding the dashboard UI. It states why the old page was replaced, the options weighed for each material choice and the selection, and, in the audit at the end, every defect found in the old page with the spec lines that fix it or the reason it is left. The resulting design is [dashboard-design.md](../dashboard-design.md) (The UI); the behaviour is the `DASH-UI`, `DASH-VIEWERS`, `DASH-ACC`, `DASH-NAV`, `DASH-THEME`, `DASH-A11Y`, `DASH-SET`, `DASH-BUILD`, `DASH-SECRET` and `DASH-OPT` lines of [dashboard-specs.md](../dashboard-specs.md).

## Context

The dashboard page was one static HTML file of about 900 lines: CSS, markup built as strings, and the application script in one `<script>`, read once at server start. It grew by accretion from a feed viewer into the operator's whole console (live feed, services and stack control, injection, viewers, a schema-driven settings editor). The audit below walked it screen by screen and state by state at commit `72b57b8` and found 7 blocking defects (tokens asked for by a blocking prompt, a rejected token that can never be replaced, a services table rebuilt every second that drops keyboard focus, an empty personality editor that Save writes over the file, viewer rows no keyboard can reach, status carried by colour alone, a nine-column table that scrolls the whole page sideways on a phone), plus a long tail of confusing, inaccessible and unfinished behaviour. Most of them share a cause: the page has no component model, so every list, dialog and form is hand-built string HTML with its own state, escaping and focus handling, and the same pattern is repeated fifteen times in the settings editor.

The owner's direction is a full rebuild: a React and TypeScript app, the Aurora theme, a restructured shell (wrapping header, hash routes, shortcuts), a settings screen driven entirely by the schema (so it names no section itself), an Access dialog in place of `window.prompt()`, secrets editable from the screen, and no behaviour lost. The backend HTTP and WebSocket API stays as it is, with the additions the screen needs, a secret write and pick-list reads, and two hardening rules found while specifying it: an Origin check on `/ws` and the control token for a config save that changes a sensitive key.

## Options and selection

### Technology

| Option | For | Against | Verdict |
|---|---|---|---|
| Keep one static HTML file, fix the defects in place | No build step; no new dependency | Fixes the symptoms and keeps the cause: string-built HTML, no reuse, no way to test components, a one-second re-render that only careful hand patching avoids | Rejected |
| **React 19 and TypeScript 7, bundled by Vite into static files the Node server serves** | Components with keyed rendering fix the focus and escaping classes of bug; one settings renderer serves every section; the owner asked for it; testing tools exist that run on the repository's runner | A build step and dev-only dependencies; the bundle must be built before first use | **Selected** |
| Lighter framework (Preact, Svelte, Solid, Lit) | Smaller output | Not what the owner asked for; the testing-library ecosystem and the owner's familiarity are React's | Rejected |
| Server-rendered HTML with htmx | No client build | The feed, audio sink and settings drafts are client state; a second rendering path on the server | Rejected |

Bundler: Vite (hot reload, production build and JSX transform in one config) over esbuild by script (no dev server), webpack and Parcel (more configuration for the same output) and no bundler (JSX and TypeScript untranspiled). Built output is git-ignored `services/dashboard/dist-ui/`, produced by the root `pnpm build` and by `pnpm dashboard`, rather than committed (generated hashed files in every review, stale against the source) or built on first request (the dashboard becomes a build runner). Dev mode is the Vite dev server, bound to loopback, proxying to a running dashboard: the proxy rewrites `Host` and forwards a state-changing request or `/ws` upgrade only when its `Origin` is the dev server's own, rewriting it to the target's and refusing any other, so the dashboard's Host and Origin checks stay as strict as in production (dropping `Origin` would let a cross-site simple `POST` through the dev server pass the dashboard's check); `vite build --watch` is the alternative.

TypeScript 7 is the monorepo's root compiler, not a UI-specific one: the UI is transpiled by Vite, and `tsc -p services/dashboard/ui --noEmit` only type-checks it, so the UI shares the root `typescript` (`^7.0.2`) and its `tsc` rather than carrying a second compiler.

### Dependencies

Every new dependency is dev-only: it is bundled into the static files or run by tests, and the running dashboard still loads only `ws` and the workspace packages. Versions are the npm registry's `latest` on 2026-11-15; the lockfile pins them.

| Package | Version | Reason |
|---|---|---|
| `react`, `react-dom` | 19.3.1 | The UI framework (owner decision) |
| `typescript` | 7.0.2 | Type-checking the UI with the rest of the monorepo; the root `typescript` dependency |
| `@types/react`, `@types/react-dom` | 19.3.0 | Types for React |
| `vite` | 8.3.8 | Bundle, dev server; needs Node `^20.19.0 \|\| >=22.12.0`, which the root `engines.node` of `>=26` satisfies |
| `@vitejs/plugin-react` | 6.3.0 | JSX transform and hot reload under Vite |
| `happy-dom`, `@happy-dom/global-registrator` | 21.0.4 | DOM emulation registered as globals for `node:test`; implements `<dialog>.showModal()` |
| `@testing-library/react` | 16.3.3 | Rendering and role-based queries in tests |
| `@testing-library/dom` | 10.4.2 | Peer of the above |
| `@testing-library/user-event` | 14.6.12 | Realistic clicks, typing and focus in tests |

Considered and not added: `vitest` 5.1.0 (below), `jsdom` 31.0.1 (below), a router, a state library, a CSS framework, a component library, an icon package and web fonts (the design needs none: hash routing is about forty lines, state is React context over small stores, the theme is plain CSS on custom properties, icons are inline SVG, fonts are the system stacks).

### Test approach

Constraint: an earlier owner decision (2026-11-01) rules out Playwright or any real-browser dependency.

| Option | For | Against | Verdict |
|---|---|---|---|
| **`node:test` + `tsx` with `happy-dom` and Testing Library** | One runner and one `pnpm test` for the whole repository; no second config; `happy-dom` has `showModal()` | An emulated DOM shows no layout, real focus trapping or autoplay behaviour (covered by Manual verification) | **Selected** |
| `node:test` + `tsx` with `jsdom` | More complete in some DOM areas | `HTMLDialogElement.showModal` is undefined in the checked version (31.0.1), and every confirmation in the design is a modal `<dialog>` | Rejected |
| Vitest with `happy-dom` or `jsdom` | Watch mode, coverage, per-file isolation, native CSS and JSX handling | A second runner beside the sixty-odd `node:test` files, a second command in `pnpm test`, and config coupled to Vite | Named alternative: adopt it if the suite later wants watch mode or coverage |
| Playwright or another real browser | Real layout, focus and audio | Ruled out by the owner | Rejected |

A spike on 2026-11-15 ran a React component with a modal `<dialog>` and an `<output>` under `node --import tsx --test` with `happy-dom` registered and `@testing-library/react`: the dialog opened, the `<output>` was found by text, and the test passed. The JSX transform took its setting from the nearest `tsconfig.json`.

### Theme

Six candidate palettes (Lagoon, Broadcast, Moss, On Air, Graphite, Aurora) were each checked for 4.5:1 text contrast against every surface and every colour stop of the background gradient, and 3:1 for control borders, in light and dark. All passed. The owner picked Aurora: sky blue for actions, soft violet for "you are here", navy easing to violet. Tokens are CSS custom properties; the OS scheme drives the default with an Auto/Light/Dark override. Two corrections to the mock-up's component rules: `--accent-fill` (the bright sky blue) does not reach 3:1 on a light surface, so controls keep a `--ctl` or `--accent` border and the fill is never a control's only boundary; and colour is never the only carrier of a status (shape and word as well).

### Access model

| Option | For | Against | Verdict |
|---|---|---|---|
| `window.prompt()` per tab (what the old page did) | No UI | Unmasked, unexplained, blocks the page, a wrong token sticks | Rejected |
| **An Access dialog: masked field, where to find the value, checked before it is stored, per-tab storage by default, per-browser opt-in** | Fixes every access finding; no new server state | Needs the check to use existing endpoints | **Selected** |
| A server-issued session cookie | Token never in page storage | Server session state, CSRF handling, and a login route, for a token the owner already holds | Rejected |
| Always `localStorage` | No re-asking | Persistent on a shared machine by default | Rejected as the default; kept as an opt-in |

The check uses existing endpoints (`PUT /secrets/access-check` for the control token, `GET /viewers` for the viewers token) because both gates run before the request's body is read. The secret route checks the token before the path in both control modes and writes nothing for a path that is no secret path, so `401` (wrong token) against `404` (right token) is the answer whatever `CONTROL_ENABLED` says; a dry-run `PUT /config/dashboard?dryRun=1`, which is ungated with control mode off, cannot test a token there and is not used. The five variables `CONTROL_TOKEN`, `CONTROL_ENABLED`, `CONTROL_ADVANCED`, `DASHBOARD_HOST` and `VIEWERS_TOKEN` stay `.env`-only, and the dialog says where they take effect.

### Secrets

Owner decision: all configuration is edited from the screen, including API keys, tokens and passwords. Options: keep them `.env`-only with a "set it in `.env`" note (what the old page did; contradicts the decision); write them into `.env` (the owner's hand-edited file, which a running program never edits); put them in `config.yaml` (a file the owner diffs and shares, which a secret must never enter). **Selected:** a write-only route storing them in a separate git-ignored `config/secrets.yaml` that the loader merges over `config.yaml`; reads report only Set or Not set. The route always requires the control token, even with control mode off, because it is the one write whose payload is a credential, and a config save that changes a sensitive key (one that decides where a credential or the co-host's private context goes) needs the same token in both modes, because it can redirect what the route stored. A value is trimmed of leading and trailing whitespace on write and an empty one is refused; clearing is `null`.

### Settings metadata source

| Option | Verdict |
|---|---|
| A table of titles, groups, help text and widget hints inside the UI (the mock-up's approach) | Rejected: two copies of a setting's name drift apart, and the audit found 26 keys with no help text and 9 sharing one generic sentence |
| A hand-written page per section | Rejected: fifteen pages to keep in step with the schema |
| **Presentation metadata in `GET /config/schema`** (per section `title`, `group`, `about`, `page`; per key `help`, `label`, `unit`, `widget`, labelled options), rendered by one generic screen | **Selected:** the help sits next to the key it describes and a new setting appears with no UI change |

A key or section with missing or unknown metadata renders with the generic control for its type and is never hidden, so a schema change cannot make a setting unreachable. The exact encoding of the metadata is the config segment's; the screen reads it through one module.

### Pick lists

The model and voice widgets need the installed Ollama models and the voice server's voices. The browser cannot ask either server: neither sends CORS headers and neither is meant to face a browser (the dashboard sends none either). **Selected:** two read-only dashboard routes, `GET /options/models` and `GET /options/voices`, ungated like `GET /config/*`, answering `502` when the backing server is down, in which case the screen shows a plain text box with the current value. A hard-coded list would be stale the day a model is pulled. An OBS-sources list is a recorded follow-up.

### Routing and structure

URL hash routing: the server has one HTML route and the LAN listener allow-lists exactly `GET /`, so the History API would need a fallback on both listeners and would collide with `/cohost/` and the API paths. The wrapping header (brand, nav, status, controls), keyboard shortcuts, dialogs for every confirmation and prompt, per-control action feedback and the connection banner follow the mock-ups and the audit.

## Dispositions in this change

Every finding in the audit below has a disposition: **Fixed by** names the spec lines that require the fix, **Fixed by design** names a structural fix with no behaviour a test could state, and **Deferred** gives the reason.

## Audit of the old page

Every problem found in `services/dashboard/public/index.html` at commit `72b57b8`, walked screen by screen and state by state (live, services, viewers, settings, empty, loading, error, offline, Redis down, services unknown). Severity: **blocker** stops a task or loses data, **bad** makes a task error-prone or confusing, **rough** is polish. Each row carries its fix, or the reason it is left.

### Tokens and access

| # | Sev | Finding | Disposition |
|---|---|---|---|
| A1 | blocker | Both tokens are asked for with `window.prompt()`: unmasked, no explanation of where the value lives, and the prompt blocks the page (feed and audio stall behind it). | Fixed by DASH-ACC-002, DASH-ACC-003, DASH-ACC-011, DASH-ACC-012, DASH-UI-006, DASH-UI-033: an Access dialog (`<dialog>`) with a masked field, Show, the env var name and a copyable command that prints it; the feed and audio keep running behind it. |
| A2 | blocker | A rejected token stays in `sessionStorage` and is never asked for again. Every later action fails with 401 and nothing says why; the only recovery is closing the tab. | Fixed by DASH-ACC-004, DASH-ACC-005, DASH-ACC-006: the token is checked before it is stored; a 401 with a stored token clears it and reopens the dialog with "rejected". |
| A3 | bad | The token is asked for once per tab, so every new tab and every reload in a new tab asks again. | Fixed by DASH-ACC-007: "Stay unlocked: this tab / this browser"; browser-wide storage is opt-in. |
| A4 | bad | Nothing shows whether the page is unlocked, and there is no way to lock it or change the token. | Fixed by DASH-ACC-001, DASH-ACC-008: an Access button showing Locked or Unlocked, opening a panel with Change token and Lock per token. |
| A5 | bad | With `VIEWERS_TOKEN` unset the Viewers tab shows the server's one-line 403 text in place of the list. | Fixed by DASH-ACC-009, DASH-VIEWERS-016: a setup state with numbered steps, the copyable `echo "VIEWERS_TOKEN=…" >> .env` line and Check again; no field to paste into, since there is nothing to paste yet. |
| A6 | bad | The action that triggered the prompt is not named, and after a cancelled prompt the action fails silently. | Fixed by DASH-ACC-002: the dialog names the waiting action and runs it on unlock; Cancel reports "not done: locked". |
| A7 | bad | With service control off, nothing explains why the Services tab has no buttons. | Fixed by DASH-UI-029: a "Service control is off" note naming `CONTROL_ENABLED=1` and `cohostctl`. |
| A8 | rough | Secret config keys show only "set"/"not set" beside a raw `source` word. | Fixed by DASH-SET-009, DASH-SECRET-001, DASH-SECRET-002: secrets are set, replaced and cleared on the Settings screen through a masked field and reported as Set or Not set; no `.env` instructions are needed. |
| A9 | bad | `CONTROL_TOKEN` is compared untrimmed by the server while the page trims what is typed, so a token with stray whitespace in `.env` can never match. | Deferred: server behaviour in the control-plane segment, reported and not changed here. DASH-ACC-005's things to check name the whitespace case. |

### Structure and navigation

| # | Sev | Finding | Disposition |
|---|---|---|---|
| S1 | bad | The header mixes identity, three status pills, four tabs, a link and two controls in one unwrapped row; under about 900 px it overflows. | Fixed by DASH-NAV-002, DASH-A11Y-007: brand, nav, status cluster and controls as wrapping groups; on a phone the nav is its own full-width row. |
| S2 | bad | The current view is not in the URL, so a reload always lands on Live. | Fixed by DASH-NAV-001: the view is the URL hash (`#services`); back and forward work. |
| S3 | bad | The personality editor takes the largest block of the Live view, though it is edited rarely and is not live state. | Fixed by DASH-SET-001, DASH-SET-014, DASH-SET-015, DASH-NAV-004: the personality editor is the first page of Settings, with an unsaved-changes guard. |
| S4 | bad | Start mode and Isolated sit in a bar above the table, far from the row buttons they modify, and apply to whichever row is clicked next. | Fixed by DASH-UI-008: start mode and Isolated live in the Start/Restart dialog. |
| S5 | bad | The stack panel is hidden entirely when control is off, so "stack down", the Docker detail and "bus unreachable" are only a word in a header pill. | Fixed by DASH-UI-018, DASH-UI-017: the stack card always shows state and cause; only its buttons depend on control. |
| S6 | bad | The test drawer opens below the services table with no scroll or focus move; on a long table it opens off-screen. | Fixed by DASH-UI-032, DASH-A11Y-005: a `<dialog>` side sheet that takes focus and returns it on close. |
| S7 | rough | Settings sections are a `<select>` of dotted paths; nothing shows which sections hold unsaved edits. | Fixed by DASH-SET-001, DASH-SET-006: a grouped section list beside the form with an edit count per section. |
| S8 | rough | Headings are jargon or lowercase fragments ("bus", "test inputs"), with mixed casing on buttons ("Launch", "mute"). | Fixed by DASH-NAV-002, DASH-UI-027, DASH-SET-002: plain names ("Activity", "Test inputs", "Say a line"); sentence case is a copy rule applied throughout and has no EARS line of its own. |
| S9 | rough | Section order in Live puts rare, risky "wipe context" beside the most-used Say button. | Fixed by DASH-UI-028: Wipe context is its own card with an explanation and a danger style. |

### Controls and interaction

| # | Sev | Finding | Disposition |
|---|---|---|---|
| C1 | blocker | The services table is rebuilt with `innerHTML` every second, which drops keyboard focus and hover from its buttons once a second. A keyboard user cannot reliably press Restart. | Fixed by DASH-UI-007: rows are keyed and patched; only the last-seen text updates on the tick. |
| C2 | blocker | If `GET /personality` fails, the editor stays empty with no message, and Save then overwrites `personality.md` with an empty file. | Fixed by DASH-SET-014: a load failure shows an error with Retry and disables Save until a load succeeds. |
| C3 | blocker | Viewer rows are `<div>`s and note actions are `<a>` without `href`: none are reachable by keyboard. Selecting a viewer, deleting, undoing and unlinking need a mouse. | Fixed by DASH-VIEWERS-010 to 015, 020, 021 and DASH-A11Y-003: real `<button>` elements. |
| C4 | bad | Say, Wipe context, Pause and Resume ignore the response: a failure (401, 500 with Redis down) shows nothing. | Fixed by DASH-UI-015: every action reports its outcome beside it; failures stay until dismissed. |
| C5 | bad | Wipe context has no confirmation; Unlink a Discord id has none either. | Fixed by DASH-UI-028, DASH-VIEWERS-014, DASH-VIEWERS-021, DASH-SET-009: wipe, clear, unlink and clearing a secret confirm in a dialog that says what is lost. |
| C6 | bad | Every confirmation is `window.confirm()`, and reasons are collected with `window.prompt()` holding three paragraphs of text. | Fixed by DASH-UI-033, DASH-VIEWERS-012, DASH-VIEWERS-014, DASH-VIEWERS-020, DASH-UI-008: `<dialog>` forms with a labelled field and the explanation as help text. |
| C7 | bad | Start, Stop and Restart hold the request open with the button still enabled, so a second click returns 409 "busy". | Fixed by DASH-UI-008: the row shows its progress and its buttons are disabled until the request settles. |
| C8 | bad | Changing the settings section discards unsaved edits silently; so does leaving the tab's personality editor by reloading. | Fixed by DASH-SET-006, DASH-NAV-004: edits are kept per section; leaving the page with unsaved edits asks first. |
| C9 | bad | A settings field that is not a number or not valid JSON prints one message and is silently left out of Save. | Fixed by DASH-SET-005: the field is marked invalid with its own message and Save is disabled while any field is invalid. |
| C10 | bad | Server validation issues are printed as a text block under the form, away from their fields. | Fixed by DASH-SET-005: each issue attaches to its field (`aria-describedby`); issues with no field stay in a summary. |
| C11 | bad | Apply clears the pending-restart list before restarting, so a unit whose restart fails disappears from the list. | Fixed by DASH-SET-008: a unit leaves the list only when its restart succeeds. |
| C12 | bad | Save and Validate send a request even with zero edits. | Fixed by DASH-SET-006: Check and Save are disabled until there is an edit. |
| C13 | bad | The feed scrolls to the bottom on every event, so reading back is impossible while events arrive. | Fixed by DASH-UI-026: follow-latest turns off on scroll up and shows "Jump to latest". |
| C14 | bad | At bus level the image and audio controls are disabled with no reason given. | Fixed by DASH-UI-009: one kind selector showing, per kind, the text field and viewer fields, the image picker, or the audio picker, name field and record button; bus-only is an Advanced disclosure that says image and audio need the real pipeline. |
| C15 | bad | Three separate send buttons (text, image, audio) share one status line; it is unclear which the status refers to. | Fixed by DASH-UI-009: one kind selector, one Send button, one status. |
| C16 | rough | Mute state is page-local: after a reload the button says "mute" while the co-host is muted. | Partly fixed by DASH-UI-005: the state is taken from `control` events in the feed replay. Deferred: no endpoint reports mute state (control-plane segment), recorded in the design's Open Questions. |
| C17 | rough | The viewer search sends a request on every keystroke. | Fixed by DASH-VIEWERS-010: 200 ms debounce; the stale-answer guard stays. |
| C18 | rough | No keyboard shortcuts for the frequent actions. | Fixed by DASH-NAV-003: `/` focuses Say, `1` to `4` switch screens, `m` mutes, `Esc` closes dialogs, `?` lists them; inactive while typing. |
| C19 | rough | Controls use browser-default selects, checkboxes and file inputs beside custom buttons. | Fixed by DASH-SET-016 to 024, DASH-UI-009, DASH-ACC-003: all native elements restyled from one set of tokens; small enums become segmented radio groups, on/off settings become switches, bounded numbers sliders. |
| C20 | rough | Uploads over the server's size limit fail only after the whole file is sent. | Fixed by DASH-UI-034: the picker states its limit and refuses a larger file before sending, reading the limit from `GET /config/dashboard` (`dashboard.inject.*`); a 413 from the server is shown in full by DASH-UI-015. |
| C21 | bad | The reflexes setting, a list of structured reactions (pattern, senses, lines, emotion, cooldown), is edited as a raw JSON box: a missing comma or a mistyped sense name is found only when Save fails, and nothing says what the fields mean. | Fixed by DASH-SET-020, DASH-SET-026: a card per item with a control for each property and Add and Remove; raw JSON stays only as the labelled fallback for a shape with no renderer. |

### Information

| # | Sev | Finding | Disposition |
|---|---|---|---|
| I1 | bad | When the WebSocket drops, the only sign is the status pill reading "reconnecting…". The feed, services and stack keep showing old data, and service ages keep counting as if current. | Fixed by DASH-UI-001: a banner states when data stopped; stale regions are `aria-busy` and dimmed until reconnect. |
| I2 | bad | Failures of the initial `GET /services/manifest` and `/services/control` are swallowed, leaving a table with no buttons and no message. | Fixed by DASH-UI-031: an error state with Retry. |
| I3 | bad | Service state is a coloured word with no reason; "degraded" and "stale" are unexplained, and the cause (`needs`, `detail`, restarts, deps) is spread over four columns. | Fixed by DASH-UI-007: a "why" sentence composed from those fields; services needing attention sort first. |
| I4 | bad | Feed rows show raw event type names (`brain.say`, `voice.utterance`). | Fixed by DASH-UI-027: plain labels (Co-host, Voice) with the event type as the tooltip and in the row's accessible name; co-host lines are visually primary. |
| I5 | rough | Feed times have no timezone or date; a replayed event from before midnight looks like today's. | Fixed by DASH-UI-026: the feed header states the timezone; rows older than today carry the date. |
| I6 | rough | "last seen 3s ago", "restarts 0" and `—` cells are unlabelled on narrow screens once the header row scrolls away. | Fixed by DASH-A11Y-007: a stacked row layout on phones with inline labels. |
| I7 | rough | Settings show `source` words (`env-default`, `composite`, `literal`) with no meaning, and schema descriptions are not shown at all. | Fixed by DASH-SET-004, DASH-SET-003: the source column reads `config.yaml`, `default` or `secret`; each key shows its help, default and range. |
| I8 | rough | The note strength bar is a bare unlabelled bar with the value only in a `title`, and nothing says what the strength means: not that it is a 0 to 100% measure of how firmly the co-host remembers a note, that it fades with a half-life, that it rises when the topic comes up again, or that it decides which notes are used. | Fixed by DASH-VIEWERS-022, DASH-VIEWERS-011: a labelled explainer above the notes, and a `<meter>` that shows a word and the percentage with what happens next. |
| I9 | rough | The stack action line shows `launch: compose-build · 2m 04s` with raw phase names. | Fixed by DASH-UI-020: phases in words, with the step (1 of 2 or 2 of 2) for launch and rebuild, the two phases the control plane reports. |
| I10 | rough | "Settings take effect when the services that read them restart" is a static hint; after a save it is easy to miss the Apply button below the form. | Fixed by DASH-SET-007: a post-save banner at the top of Settings with the restart action in it. |
| I11 | bad | 26 settings keys have no help text, and 9 more share one generic sentence, so the operator cannot tell what they do or what a sensible value is. | Fixed by DASH-SET-004: every key shows its `help` from the schema's presentation metadata, and the screen holds no help text of its own. The text itself is the config segment's to write (reported). |
| I12 | bad | Some settings are shown read-only, or are silently overridden by an environment variable (`env`, `env-default` and `composite` sources), so a value saved on the page can have no effect and nothing says why. | Fixed by DASH-SET-003: no key is shown read-only because of an environment variable and the source column reads `config.yaml`, `default` or `secret`; the config segment removes the environment overrides from the settings file (reported). |
| I13 | rough | Settings pages are titled with raw config identifiers (`brain.salience`, `llm`) and the section list is a flat dropdown of them. | Fixed by DASH-SET-001, DASH-SET-002, DASH-SET-003: plain titles and groups from the schema metadata, a heading, a line saying what the section affects, then the config path. |

### Accessibility

| # | Sev | Finding | Disposition |
|---|---|---|---|
| X1 | blocker | Status is carried by colour alone: state badges, dependency states and feed kinds differ only in hue. | Fixed by DASH-THEME-004: every status has a distinct shape and a word as well as a colour. |
| X2 | bad | `.ev.status` rows are drawn at 55% opacity, about 3.4:1 against the panel. | Fixed by DASH-THEME-003: a dedicated faint text token at 4.5:1 or better on every surface; no opacity for text. |
| X3 | bad | No focus style is defined; the default outline is nearly invisible on the dark panels. | Fixed by DASH-A11Y-002: a 2 px accent focus ring on every interactive element. |
| X4 | bad | Status messages (save results, inject results, errors) are not announced to screen readers. | Fixed by DASH-A11Y-004: `<output>` for results, `role="alert"` for failures, `role="log"` for the feed. |
| X5 | bad | Most inputs have a placeholder but no label; the tabs are plain buttons with no `nav` landmark or current marker. | Fixed by DASH-A11Y-003, DASH-NAV-002: a label for every field; `<nav>` with `aria-current="page"`. |
| X6 | bad | Row buttons are about 20 px tall. | Fixed by DASH-A11Y-006: 30 px minimum in dense desktop rows, 44 px on touch widths. |
| X7 | rough | Only a dark theme exists. | Fixed by DASH-THEME-002: light and dark from `prefers-color-scheme`, with an Auto/Light/Dark override kept in the browser. |
| X8 | rough | Emoji carry meaning in the audio button, and they render differently per platform. | Fixed by DASH-A11Y-008: inline SVG icons with text labels. |
| X9 | rough | No reduced-motion handling. | Fixed by DASH-THEME-005: transitions and the progress animation are off under `prefers-reduced-motion`. |

### Responsiveness

| # | Sev | Finding | Disposition |
|---|---|---|---|
| R1 | blocker | The nine-column services table has no overflow container, so the whole page scrolls sideways on a phone. | Fixed by DASH-A11Y-007, DASH-UI-007: a layout that stacks to name, state, reason and actions on narrow widths. |
| R2 | bad | Settings rows use a fixed 240 px label column with `word-break: break-all`, which breaks key names mid-word. | Fixed by DASH-A11Y-007, DASH-SET-004: a two-column row that stacks on phones; names wrap at dots. |
| R3 | bad | The viewer list height is `calc(100vh - 230px)`, a guess that clips or leaves gaps as the header wraps. | Fixed by DASH-A11Y-007: the list sizes from its container and stacks above the panel on phones. |
| R4 | rough | Long values (service names, tokens, viewer names, heartbeat detail) are not wrapped and push columns. | Fixed by DASH-A11Y-007: long names, ids and details wrap. |
| R5 | rough | Side gutters are 12 px and controls sit closer than 8 px. | Fixed by DASH-A11Y-007: a 16 px gutter on phones; 20 px on desktop and an 8 px spacing scale (design, Theme). |

### Code and behaviour

| # | Sev | Finding | Disposition |
|---|---|---|---|
| K1 | bad | Two interpolations skip `esc()`: the event type in a feed row and the service state used as a class and as text. Both come from bus data. | Fixed by DASH-UI-030: every bus-derived value is rendered as text. |
| K2 | bad | `JSON.parse` on a WebSocket frame is unguarded and `onerror` is unhandled; one bad frame throws inside the handler. | Fixed by DASH-UI-001: a frame that is not valid JSON is dropped. |
| K3 | bad | The control-token and viewers-token fetch wrappers are two copies of the same code. | Fixed by design: one `api` module attaches the token for a request's kind (The UI, Technology); a structure, not a behaviour, so no EARS line. |
| K4 | rough | About forty inline `style` attributes carry layout, so spacing cannot be changed in one place. | Fixed by DASH-THEME-006: layout moves to classes built on spacing tokens. |
| K5 | rough | The platform list, the inject target map and the 10 s result timeout are hardcoded in the page. | Left: no endpoint supplies the platform list, the inject target map or the 10 s result timeout; they are named constants in one module (design, Feed handling). |
| K6 | rough | Hard-coded hex colours appear beside the custom properties (`#232838`, `#1d2129`, `#0f1218`, `#c7a5ff`). | Fixed by DASH-THEME-001: every colour is a token. |

### Found outside the page

Reported, not changed in this work unless a row says fixed: the backend HTTP and WebSocket API stays as it is, apart from the secret write, the pick lists, the `/ws` Origin check and the sensitive-key gate.

| # | Finding | Owner | Disposition |
|---|---|---|---|
| O1 | `/ws` never checks `Origin`, so any web page open in the operator's browser can read the feed from `ws://localhost:3000/ws`. | dashboard host (`DASH-HOST`) | Fixed by DASH-HOST-008: a `/ws` upgrade whose `Origin` is not its own `Host` is refused on both listeners; a missing `Origin` (a non-browser client) is accepted. |
| O2 | The LAN listener accepts `/ws` with no guard, wider than the sink-only surface `DASH-HOST-002` describes. | dashboard host | Fixed for a page from another origin by DASH-HOST-008, which applies to both listeners; deferred for a non-browser LAN client, which sends no `Origin` and still reads the feed (the LAN is the trust boundary); recorded in Open Questions. |
| O3 | `POST /control` and `POST /sink` answer 500 with raw error text for bad JSON or a bad `cmd`, where 400 is meant. | dashboard HTTP | Deferred: changes the behaviour of existing routes (DASH-HTTP-004, DASH-HTTP-007) outside this work; the UI shows the status and detail either way (DASH-UI-015). |
| O4 | `docs/advanced/reference/http.md` says lifecycle routes answer 409 for the dashboard itself; the code answers 404 "unknown service". | docs site | Deferred to the docs-site segment, which edits that page for DASH-DOCS-016. |
| O5 | No endpoint reports mute or pause state. | control plane | Deferred: recorded in Open Questions (C16). The inject size limits are read from `GET /config/dashboard` (C20). |
| O6 | The Spec Coverage table in `docs/arrows/dashboard.md` disagrees with its own status line. | arrow overlay | Fixed: the arrow doc's coverage table is rebuilt from the spec file's markers. |
