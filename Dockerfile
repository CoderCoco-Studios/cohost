# One Dockerfile for every TypeScript service. Select with --build-arg SERVICE=<name>.
# The whole workspace is built once (layer-cached across services), then pruned to prod deps.
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
RUN pnpm prune --prod

FROM base AS runtime
ARG SERVICE
ENV NODE_ENV=production SERVICE=${SERVICE}
COPY --from=build /app /app
# config is bind-mounted at runtime (see docker-compose.yml)
CMD ["sh", "-c", "exec node services/${SERVICE}/dist/index.js"]
