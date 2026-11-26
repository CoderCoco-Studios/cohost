# One Dockerfile for every TypeScript service. Select with --build-arg SERVICE=<name>.
# The whole workspace is built once (layer-cached across services) and shipped as-is.  @spec DEPLOY-IMG-001
# The build stages run the same mise.toml tasks a developer runs; this file runs no cargo, pnpm, npm, corepack
# or tsc command of its own and names no toolchain version except ARG MISE_VERSION and the runtime's node: tag,
# both held to mise.toml by the toolchain test (DEPLOY-TOOL-002).  @spec DEPLOY-IMG-006
# Do NOT `pnpm prune --prod` here: on pnpm 10 it empties services/*/node_modules and drops the
# @cohost/* workspace links, so every service dies with ERR_MODULE_NOT_FOUND (#6).
# (`pnpm deploy --prod` was tried instead; it needs inject-workspace-packages lockfile settings.)  @spec DEPLOY-IMG-003

# mise itself: the release mise.toml's min_version names, signature- and checksum-verified before it is unpacked.
# Debian 13 (trixie) is the release the runtime's node image is built on. No C toolchain: Zig links the addon.
# @spec DEPLOY-TOOL-020
FROM debian:13.8-slim AS toolchain
ARG MISE_VERSION=2026.11.14
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
    && rm -rf /var/lib/apt/lists/*
COPY scripts/fetch-mise.sh scripts/mise-release-key.asc /tmp/fetch-mise/
RUN /tmp/fetch-mise/fetch-mise.sh "$MISE_VERSION" /usr/local/bin/mise && rm -rf /tmp/fetch-mise
ENV MISE_TRUSTED_CONFIG_PATHS=/app MISE_YES=1
WORKDIR /app

# Rust addon: only Rust (from rust-toolchain.toml) and Zig (from mise.toml), installed through mise from
# mise.lock, then the build:native task. No package.json, Node or napi CLI in this stage.
# @spec DEPLOY-IMG-001, DEPLOY-TOOL-018
FROM toolchain AS native
COPY rust-toolchain.toml mise.toml mise.lock ./
RUN mise install --locked rust zig
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY scripts/zig-cc scripts/zig-cxx scripts/zig-ar ./scripts/
RUN --mount=type=cache,target=/root/.local/share/mise/cargo/registry \
    --mount=type=cache,target=/root/.local/share/mise/zig-cache \
    --mount=type=cache,target=/app/target \
    MISE_TASK_RUN_AUTO_INSTALL=false mise run build:native

# The TypeScript workspace: Node (mise.toml) and pnpm (package.json packageManager) through mise, then build:ts,
# whose install dependency runs pnpm install --frozen-lockfile.
# @spec DEPLOY-IMG-001, DEPLOY-TOOL-018
FROM toolchain AS build
ENV CI=true
COPY mise.toml mise.lock package.json ./
RUN mise install --locked node pnpm
COPY pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY services ./services
COPY --from=native /app/packages/bus/native/cohost-bus.linux-x64-gnu.node ./packages/bus/native/cohost-bus.linux-x64-gnu.node
RUN MISE_TASK_RUN_AUTO_INSTALL=false mise run build:ts

# The runtime carries neither mise, pnpm, Zig nor a Rust toolchain. Its Node is exactly mise.toml's.
FROM node:26.13.1-trixie-slim AS runtime
ARG SERVICE
ENV NODE_ENV=production SERVICE=${SERVICE}
WORKDIR /app
COPY --from=build /app /app
# config is bind-mounted at runtime (see docker-compose.yml). @spec DEPLOY-IMG-002
CMD ["sh", "-c", "exec node services/${SERVICE}/dist/index.js"]
