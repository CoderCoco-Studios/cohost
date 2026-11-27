# Dashboard UI

React 19 + TypeScript + Vite. Design and specs: `docs/intent/dashboard/dashboard-design.md` (The UI) and `dashboard-specs.md`. Read the design's Structure and Screens sections before building a screen.

## Layout

| Path | Holds |
|---|---|
| `src/main.tsx` | Mounts the app; `?sink` (any value) renders the sink view |
| `src/app/` | Shell (`App`, `Header`), hash routing (`routes.ts`), the screen registry (`screens.ts`), shortcuts, connection banner (`connection.tsx`), the Access dialog host (`AccessDialog.tsx`, a placeholder), `providers.tsx` |
| `src/state/` | `runtime.ts` builds the stores once: `api`, `access`, `feed`, `audio`, `theme`; `hooks.ts` reads them in React |
| `src/screens/<id>/` | One folder per screen (`live`, `services`, `viewers`, `settings`); `index.tsx` exports `Screen` |
| `src/components/` | Shared parts; each has a test in `test/ui/` |
| `src/styles/` | `tokens.css` (the only place a colour literal appears), `base.css`, `components.css`, one file per screen, and `narrow.css` (every phone-width rule, imported last) |

## Running things (always bounded)

```sh
# Node comes from mise.toml; run these in a shell where mise is active.
# one test file, capped on real memory and time (from the repo root; test:file builds first and sets the test tsconfig):
systemd-run --user --scope --quiet -p MemoryMax=4G -p MemorySwapMax=0 -- \
  timeout 300 mise run test:file -- --test-timeout=30000 --test-concurrency=2 services/dashboard/test/ui/<name>.test.tsx
node_modules/.bin/tsc -p services/dashboard/ui --noEmit   # from the repo root: typechecks src and test/ui
mise run build:ui                                         # writes services/dashboard/dist-ui
mise run dashboard:ui                                     # dev server with the proxy (loopback only)
```

`TSX_TSCONFIG_PATH=...tsconfig.test.json` is required: tsx takes its JSX settings from it, and without it a `.tsx` file fails with "React is not defined". The `test`, `test:only` and `test:file` tasks of `mise.toml` set it.

## Add a screen

A screen is one module. Edit `src/screens/<id>/index.tsx` and keep its export:

```tsx
export function Screen({ route }: ScreenProps) { ... }   // route.view, route.section (settings only)
```

- Render exactly one `<PageHeading>` (an `<h1 tabIndex={-1}>`): the shell moves focus to it after navigation.
- Read data with hooks: `useApi()` (requests), `useFeed(selector)` (services, stack, events, mute), `useFeedClock()` (a tick that stops while the socket is closed), `useAccess()`, `useAction()` (feedback state for one control). Selectors must return stable values.
- Every request goes through `api`. A gated request: `api.post(path, body, { auth: "control", action: "Restart voice" })`. The request goes out with the held token or none (an unlocked browser's session cookie stands in for it); a 401 opens the Access dialog and retries once; a cancel resolves `{ ok: false, locked: true, detail: "not done: locked" }`. `/viewers` calls use the same `auth: "control"`: there is one token.
- Show the outcome beside the control: `const a = useAction(); a.run(() => api.post(...), "Saved")` and `<ActionStatus state={a.state} onDismiss={a.dismiss} />`.
- Regions that show live data spread `useStale()` (`aria-busy` and the `stale` class while the socket is closed).
- The Live screen's Say field carries `data-shortcut="say"` so `/` can focus it. The shell owns the header, Mute, Audio and the shortcut list; reuse `useMute()` for a mute control on the screen (the header's is the shell's).
- Settings routes are `#settings/<section path>`: read `route.section`.
- No inline `style` (a run-time computed value in `components/Slider.tsx` is the only allowed one; a new one needs an entry in the allow-list in `test/ui/stylesheet.test.tsx`), no `dangerouslySetInnerHTML`, no `alert`/`confirm`/`prompt`, no emoji, no colour literal outside `tokens.css`. `stylesheet.test.tsx` and `tokens.test.tsx` fail on each.
- Screen styles go in `src/styles/components.css` (or a new `.css` imported by `main.tsx` before `narrow.css`), using tokens. Narrow-width rules (`@media (max-width: 719.98px)`) go in `narrow.css` only, which `main.tsx` imports last so they come after every rule they override; no other stylesheet holds a `max-width` media block (`stylesheet.test.tsx` fails on one).

## Add a component

A native element, fully styled by classes from `components.css`, semantics kept (label, role, keyboard). Put it in `src/components/Name.tsx`, give props a one-line doc comment, and test it in `test/ui/` by role and accessible name. Dialogs use `Dialog`/`ConfirmDialog`/`SideSheet` (native `<dialog>`, focus returns to the opener).

## Add a test

`test/ui/<name>.test.tsx`. Import `./helpers/render` first (it registers happy-dom, then re-exports `render`, `screen`, `userEvent`, `within`, `fireEvent`, `act`):

```tsx
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderApp, makeApp, screen, userEvent, act } from "./helpers/render";

// @spec DASH-XXX-001
test("...", async () => {
  const app = makeApp();                                   // runtime with fakes
  app.fetch.on("GET /services/control", { json: { enabled: false } });   // unanswered routes are 404
  renderApp(<MyScreen />, app);
  act(() => app.socket().open());                          // then app.socket().message({ type: "services", services: [...] })
  ...
});
```

Fakes in `helpers/fakes.ts`: `FakeFetch` (route table, `calls`, `callsTo`), `FakeSocket`, `FakeStorage` (`.throwing()`), `FakeAudio`, `FakeClock` (manual timers; pass `clock.now`). `dialogSupported()` in `helpers/dom.ts` checks that happy-dom's `<dialog>` works.

Rules that keep the test process safe:

- **Never `assert.equal`/`deepEqual` a DOM node** (`assert.equal(el, null)`, `assert.equal(document.activeElement, x)`). A failing assertion makes Node inspect the whole happy-dom object graph and run out of memory (this took down the VM once). Write `assert.ok(el === null, "message")`.
- Cleanup is automatic (`render.tsx` unmounts after each test, and `AppProviders` stops the feed). Do not leave timers, sockets or listeners behind; do not use `--test-force-exit`.
- Emulation gaps: arrow keys do not move a range input (use `fireEvent.change`), `<meter>` value and max read as 1 (assert the attributes), Esc is handled by the shell's shortcut (`user.keyboard("{Escape}")` closes the open dialog), no layout.
- Query by role and accessible name, which checks the semantics the specs require.
