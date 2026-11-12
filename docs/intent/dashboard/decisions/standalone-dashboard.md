---
node: dashboard
---

# Decision: the dashboard as a standalone host program, and how it listens

## Context

The dashboard is the owner's one window onto the stack: live feed, controls,
personality editor, Services tab, Viewers page, test-input injection, and the
browser audio sink that an OBS Browser Source uses to put the co-host's voice
on stream. Every other service runs in Docker Compose. The owner wants a single
thing to start: the dashboard, which then brings up the whole application with
a Launch button and can stop and restart it.

Two choices follow, and a cold reader could question either:

1. **Where the dashboard runs.** In Compose with everything else, or as a host
   process outside Compose. This part is an owner decision.
2. **How the host process listens.** Launching and stopping the stack are the
   most powerful actions cohost offers, so they are host-local by default and
   token-gated whenever the owner opens them to other machines; but an OBS
   Browser Source on a second PC must still load the sink page. One listener
   cannot be both loopback-only and reachable from the LAN. This part
   is also an owner decision.

What is at stake: a containerised dashboard cannot start the stack it belongs
to; a dashboard with Docker access that is reachable from the LAN would let
anyone with the token (sent in cleartext over plain HTTP) start and stop the
owner's machine's containers.

## Decision Elements

Gates:

- **Starts first, needs nothing else running** (owner decision). The program
  the owner starts must come up with Docker's daemon, Redis and every service
  absent, and bring them up itself.
- **No container with root-equivalent host control** (inherited from the
  control plane's decision to drive Compose through the host's `docker` CLI and
  never mount the Docker socket into a container).

Weighted criteria:

- **Host-locality of the stack and lifecycle actions** (major; HLD Trust
  boundary): by default the actions that start, stop or restart containers
  should be reachable only from the host itself, by construction rather than by
  a check every new route must remember.
- **The full dashboard from another machine, when the owner chooses** (major):
  cohost runs on a dedicated PC, and the owner opens the full dashboard over a
  web port from another machine; whenever that is enabled, the stack,
  lifecycle and viewer-notes routes must still demand their tokens.
- **The sink keeps working from a second PC** (major; HLD Goal 8 and the
  two-PC setup in the README): an OBS Browser Source cannot authenticate, so
  the sink routes stay ungated and must stay reachable from the LAN.
- **Containers get test uploads** (moderate; HLD Goal 7, testable one
  piece at a time): eyes and ears receive injected uploads without the host
  having to be reachable from a container (they travel over Redis).
- **URL stability** (moderate): the owner's bookmarks and OBS sources keep
  working across the change.
- **Moving parts** (minor): ports, environment variables, and code paths to
  keep right.

## Options in the Domain

### Where it runs: in Compose (monitor-only), control from a host-run copy or `cohostctl`

The dashboard stays a Compose service with control pinned off; stack actions
come from `cohostctl` or a second, host-run copy of the dashboard. Fails the
first gate: nothing in Compose can be the first thing started, and two
dashboards is two things to start.

### Where it runs: in Compose with the Docker socket mounted

The container gets `/var/run/docker.sock` and runs `docker compose` itself.
Fails the second gate. It also still cannot start the stack it is a member of
when the stack is down.

### Where it runs: a host process (chosen)

The owner starts the dashboard on the host (`pnpm dashboard`).
It uses the owner's own `docker` CLI access, so it needs no privilege of its
own, and it is up before anything else. Compose drops its `dashboard` service.
Consequences: the dashboard reaches Redis on the loopback port Compose already
publishes, reaches voice on a newly published loopback port, reads and writes
the same `./config` files Compose bind-mounts, and must start and serve its
page with Redis down.

### How it listens: one loopback listener (status quo of control mode)

Everything on `127.0.0.1:3000`. Host-local by construction, but an OBS Browser
Source on a second PC cannot load the sink. Fails a major criterion.

### How it listens: one all-interfaces listener with a loopback-peer check

Everything on `0.0.0.0:3000`; every gated route also refuses a request whose
peer address is not loopback. The sink and every URL stay where they
are. Host-locality then depends on a check that each gated route, including
routes added later, must apply; a missed check exposes a Docker-driving route
to the LAN with only the cleartext token in front of it.

### How it listens: two listeners (chosen)

The full surface on `DASHBOARD_HOST` (default `127.0.0.1`; `0.0.0.0` makes it
reachable from another machine) at the dashboard port (default 3000); a second
listener on all interfaces at `DASHBOARD_LAN_PORT`
(default 3001) whose handler knows only the ungated routes a sink page
needs: `GET /`, `/ws`, `GET /audio/*`, `POST /sink`, `/health`. Host-locality holds by construction: the LAN
listener has no code path to a gated route. The owner's own URL
(`http://localhost:3000`) and a same-PC OBS source (`http://localhost:3000/?sink=1`)
are unchanged; a second-PC OBS source moves to port 3001. When the owner sets
`DASHBOARD_HOST` to a non-loopback address, the full surface is reachable from
other machines, and the dashboard then refuses to start unless control mode
and its token are on, so every stack and lifecycle action needs
`CONTROL_TOKEN` and every Viewers route needs `VIEWERS_TOKEN`. One more port
and two more environment variables.

## Selection

A host process, because it is the only option that passes both gates (owner
decision). Two listeners (owner decision), because it is the only listening
option that keeps the control surface host-local by construction by default
(HLD Trust boundary) while the sink routes stay reachable from the LAN. A configurable full-surface host serves an owner who
runs cohost on a dedicated PC and opens the dashboard from another machine,
with the token requirement holding the stack actions and viewer notes behind
their secrets. The cost is one port and a second-PC OBS source at
`http://<ai-pc>:3001/?sink=1`.

The selection holds on the owner's first test machine, a single PC running
WSL2 with Docker Desktop and no second box: the dashboard in the distro is
reached from a Windows browser at `http://localhost:3000` through WSL's
localhost forwarding; the sink page and an OBS-style browser source are tested
on the same PC at `http://localhost:3001/?sink=1`; test uploads reach eyes and ears over Redis
(not over HTTP from a container to the host), and voice is reached on the Compose network; the dashboard reaches
Redis and voice on loopback ports Docker Desktop forwards into the distro; and
the control plane runs `docker.exe` when `docker` is not on the WSL path
(`COHOST_DOCKER_BIN`). The dashboard LLD (One PC: WSL2 with Docker Desktop)
and the deployment single-PC checklist specify each path.

Fit: the selection would flip to the peer-check option if a second-PC OBS
source had to keep `:3000`, and to a single loopback listener if the two-PC setup
and service-level image and audio injection were dropped.
