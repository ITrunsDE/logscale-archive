FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json tsconfig.json ./
COPY packages/config/package.json packages/config/
COPY packages/core/package.json packages/core/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY tests/package.json tests/
RUN pnpm install --frozen-lockfile=false

FROM deps AS build
COPY packages packages
COPY apps apps
RUN pnpm --filter @archive/config build \
  && pnpm --filter @archive/core build \
  && test -f packages/core/dist/index.d.ts \
  && pnpm --filter @archive/worker build \
  && pnpm --filter @archive/web build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends wget ca-certificates gnupg \
  && wget -qO- https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    | gpg --dearmor -o /usr/share/keyrings/postgresql.gpg \
  && echo "deb [signed-by=/usr/share/keyrings/postgresql.gpg] http://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
    > /etc/apt/sources.list.d/pgdg.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends postgresql-client-16 \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable && corepack prepare pnpm@9.15.9 --activate
COPY --from=build /app /app
COPY infra/entrypoint.sh /app/infra/entrypoint.sh
RUN chmod +x /app/infra/entrypoint.sh
ENV NODE_ENV=production
ENTRYPOINT ["/app/infra/entrypoint.sh"]
