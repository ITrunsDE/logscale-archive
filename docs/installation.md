# Installation

Production install on Linux x86_64 with Docker Compose v2.

## Image

Pin to a release digest from GitHub Releases:

```bash
export ARCHIVE_IMAGE='ghcr.io/ITrunsDE/logscale-archive@sha256:…'
```

Images are public. Verify `archive-image.sha256` and `sbom.spdx.json` from the release, then use `docker compose pull web worker` before `up --no-build`.

## Secrets

Set before starting. No defaults in production overrides.

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string |
| `ENCRYPTION_KEY` | 64 hex chars (32 bytes); encrypts LogScale tokens at rest |
| `SESSION_SECRET` | Cookie signing secret (≥32 chars recommended) |
| `RECOVERY_SECRET` | Gates break-glass admin recovery CLI |
| `INSTANCE_NAME` | Exact name required to confirm UI restores |

Generate encryption key:

```bash
openssl rand -hex 32
```

### Docker secret files (optional)

Mount files and set `*_FILE` paths. Entrypoint reads them into env:

```yaml
environment:
  DATABASE_URL_FILE: /run/secrets/database_url
secrets:
  - database_url
```

### Operations logging (optional)

Operations events are JSON on stdout by default. Direct LogScale delivery is optional.

1. Create a separate LogScale repository, for example `logscale-archive-ops`.
2. Create an **ingest token** for that repository. It must not be the read token used
   by an archive connection.
3. On the Docker host, save the token in a file. The directory is ignored by Git:

   ```bash
   install -d -m 700 infra/secrets
   editor infra/secrets/logscale_log_ingest_token
   chmod 600 infra/secrets/logscale_log_ingest_token
   ```

4. Add the LogScale URL to `.env`. Optional: set `LOG_LEVEL=debug` temporarily.

   ```dotenv
   LOGSCALE_LOG_ENDPOINT=https://logs.example
   LOG_LEVEL=info
   ```

5. Start with bundled `infra/compose.logging.yaml`. It mounts token into both
   containers; token never appears in Compose or `.env`:

   ```bash
   docker compose \
     -f infra/compose.yaml \
     -f infra/compose.production.yaml \
     -f infra/compose.external-postgres.yaml \
     -f infra/compose.logging.yaml \
     pull web worker
   docker compose \
     -f infra/compose.yaml \
     -f infra/compose.production.yaml \
     -f infra/compose.external-postgres.yaml \
     -f infra/compose.logging.yaml \
     up -d --no-build web worker
   ```

`LOGSCALE_LOG_ENDPOINT` is the LogScale base URL, for example
`https://cloud.community.humio.com`. It is not a repository URL. The ingest token
selects the target repository.

Delivery is best effort. Events include service, lifecycle and query-run metadata;
they exclude query text, result payloads, audit entries and HTTP request logs.
Every operations event has `app=logscale-archive`, suitable for LogScale dashboards.

### Event archive result limit

`LOGSCALE_EVENT_TAIL_LIMIT=1000` is the default per-query event limit. It reduces
backfill splitting for busy repositories while preserving pagination. The collector
adds `tail(...)`; scheduled query text must not add a numeric `tail(...)` itself.

## PostgreSQL

### External (recommended)

Use a managed PostgreSQL 16 instance. **TLS required:**

```bash
export DATABASE_URL='postgres://archive:SECRET@db.example:5432/archive?sslmode=require'
export REQUIRE_DB_TLS=true   # default in production overrides
```

First install:

1. Create database and role with full access to `archive` database.
2. Set `ARCHIVE_IMAGE`, secrets, and `INSTANCE_NAME` above.
3. Pull and start web + worker (postgres service excluded):

```bash
docker compose -f infra/compose.yaml -f infra/compose.production.yaml -f infra/compose.external-postgres.yaml pull web worker
docker compose -f infra/compose.yaml -f infra/compose.production.yaml -f infra/compose.external-postgres.yaml up -d --no-build web worker
```

If direct operations logging is configured, append
`-f infra/compose.logging.yaml` after `infra/compose.external-postgres.yaml`.

4. Open `http://127.0.0.1:8080` and complete first-admin bootstrap.

Migrations run automatically on web startup.

### Bundled (single-host only)

For small single-node deployments:

```bash
export DATABASE_URL='postgres://archive:SECRET@postgres:5432/archive'
export REQUIRE_DB_TLS=false
docker compose -f infra/compose.yaml -f infra/compose.production.yaml --profile bundled-db pull web worker postgres
docker compose -f infra/compose.yaml -f infra/compose.production.yaml --profile bundled-db up -d --no-build
```

If direct operations logging is configured, append
`-f infra/compose.logging.yaml` before `--profile`.

Never publish PostgreSQL to the host. Base `infra/compose.yaml` keeps postgres internal; `infra/compose.postgres.yaml` is **local dev only** (binds `127.0.0.1:5432`).

## Volumes

Production overrides mount:

| Path in container | Purpose |
| --- | --- |
| `/data/backups` | Scheduled and manual DB backups |
| `/data/exports` | Async export files |
| `/data` | Maintenance state, storage guard probes |

Map host paths or named volumes. Encrypt volumes at the host or storage layer (see [security.md](security.md)).

## Upgrade

1. Take a backup (UI **Operations** or `infra/scripts/backup.sh`).
2. Confirm recent successful backup in Operations (update guard blocks migration otherwise).
3. Set `ARCHIVE_IMAGE` to new release digest, pull and recreate containers:

```bash
docker compose -f infra/compose.yaml -f infra/compose.production.yaml -f infra/compose.external-postgres.yaml pull web worker
docker compose -f infra/compose.yaml -f infra/compose.production.yaml -f infra/compose.external-postgres.yaml up -d --no-build web worker
```

If direct operations logging is configured, use the same logging override during
every upgrade:

```bash
docker compose \
     -f infra/compose.yaml \
     -f infra/compose.production.yaml \
     -f infra/compose.external-postgres.yaml \
     -f infra/compose.logging.yaml \
     pull web worker
docker compose \
  -f infra/compose.yaml \
  -f infra/compose.production.yaml \
  -f infra/compose.external-postgres.yaml \
  -f infra/compose.logging.yaml \
  up -d --no-build web worker
```

4. Watch web logs for migration completion.

## Smoke test

After install:

```bash
curl -sf http://127.0.0.1:8080/healthz
```

Create admin user via UI. Add a LogScale connection and run a test query ([logscale-setup.md](logscale-setup.md)).

## Unsupported in V1

See [README.md](../README.md#v1-scope-unsupported).
