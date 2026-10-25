# One Dockerfile for every TypeScript service. Select with --build-arg SERVICE=<name>.
# The whole workspace is built once (layer-cached across services) and shipped as-is.
# Do NOT `pnpm prune --prod` here: on pnpm 10 it empties services/*/node_modules and drops the
# @cohost/* workspace links, so every service dies with ERR_MODULE_NOT_FOUND (#6).
# (`pnpm deploy --prod` was tried instead; it needs inject-workspace-packages lockfile settings.)
FROM node:22-slim AS base
RUN corepack enable && corepack prepare pnpm@10.0.0 --activate
WORKDIR /app

FROM base AS build
ENV CI=true
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY services ./services
RUN pnpm install --frozen-lockfile
RUN pnpm exec tsc -b

FROM base AS runtime
ARG SERVICE
ENV NODE_ENV=production SERVICE=${SERVICE}
COPY --from=build /app /app
# config is bind-mounted at runtime (see docker-compose.yml)
CMD ["sh", "-c", "exec node services/${SERVICE}/dist/index.js"]
