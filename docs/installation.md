# Installation

Production install on Linux x86_64 with Docker Compose v2.

## Image

Pin to a release digest from GitHub Releases:

```bash
export ARCHIVE_IMAGE='ghcr.io/ITrunsDE/logscale-archive@sha256:…'
```

Verify checksum against `archive-image.sha256` from the release.

## Secrets

Set before starting. No defaults in production overrides.

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string |
| `ENCRYPTION_KEY` | 64 hex chars (32 bytes); encrypts LogScale tokens at rest |
| `SESSION_SECRET` | Cookie signing secret (≥32 chars recommended) |
| `RECOVERY_SECRET` | Gates break-glass admin recovery CLI |

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

## PostgreSQL

### External (recommended)

Use a managed PostgreSQL 16 instance. **TLS required:**

```bash
export DATABASE_URL='postgres://archive:SECRET@db.example:5432/archive?sslmode=require'
export REQUIRE_DB_TLS=true   # default in production overrides
```

First install:

1. Create database and role with full access to `archive` database.
2. Set secrets above.
3. Start web + worker (postgres service excluded):

```bash
docker compose -f infra/compose.yaml -f infra/compose.production.yaml up -d web worker
```

4. Open `http://127.0.0.1:8080` and complete first-admin bootstrap.

Migrations run automatically on web startup.

### Bundled (single-host only)

For small single-node deployments:

```bash
export DATABASE_URL='postgres://archive:SECRET@postgres:5432/archive'
export REQUIRE_DB_TLS=false
docker compose -f infra/compose.yaml -f infra/compose.production.yaml --profile bundled-db up -d
```

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
3. Pull new digest, recreate containers:

```bash
docker compose -f infra/compose.yaml -f infra/compose.production.yaml up -d --pull always
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
