# One Dockerfile for every TypeScript service. Select with --build-arg SERVICE=<name>.
# The whole workspace is built once (layer-cached across services) and shipped as-is.  @spec DEPLOY-IMG-001
# Do NOT `pnpm prune --prod` here: on pnpm 10 it empties services/*/node_modules and drops the
# @cohost/* workspace links, so every service dies with ERR_MODULE_NOT_FOUND (#6).
# (`pnpm deploy --prod` was tried instead; it needs inject-workspace-packages lockfile settings.)  @spec DEPLOY-IMG-003
# The pnpm version is the root package.json "packageManager" field and nothing else.  @spec DEPLOY-IMG-006
FROM node:22-slim AS base
WORKDIR /app
COPY package.json ./
RUN corepack enable && corepack prepare "$(node -p "require('./package.json').packageManager")" --activate

# Rust addon: plain cargo, no Node and no napi CLI. The tag is the toolchain rust-toolchain.toml pins
# (lid-check does not compare them; keep both in step). bookworm = the Debian release node:22-slim is built on.
# @spec DEPLOY-IMG-001
FROM rust:1.99.1-slim-bookworm AS native
WORKDIR /src
COPY rust-toolchain.toml Cargo.toml Cargo.lock ./
COPY crates ./crates
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release -p cohost-bus-node \
    && cp target/release/libcohost_bus_node.so /cohost-bus.linux-x64-gnu.node

FROM base AS build
ENV CI=true
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY services ./services
RUN pnpm install --frozen-lockfile
COPY --from=native /cohost-bus.linux-x64-gnu.node ./packages/bus/native/cohost-bus.linux-x64-gnu.node
RUN pnpm exec tsc -b

FROM base AS runtime
ARG SERVICE
ENV NODE_ENV=production SERVICE=${SERVICE}
COPY --from=build /app /app
# config is bind-mounted at runtime (see docker-compose.yml). @spec DEPLOY-IMG-002
CMD ["sh", "-c", "exec node services/${SERVICE}/dist/index.js"]
