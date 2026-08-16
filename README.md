# LogScale Archive

LogScale Archive stores scheduled Falcon LogScale query results in PostgreSQL. Review or export stored results through a local web interface without copying a whole LogScale repository.

Licensed under [AGPL-3.0](LICENSE).

## Requirements

- Linux x86_64 host
- Docker Engine + Compose v2
- PostgreSQL 16 (bundled profile or external managed instance)
- Read-only LogScale repository token (see [docs/logscale-setup.md](docs/logscale-setup.md))

## Quick start (local evaluation)

```bash
cp .env.example .env
docker compose -f infra/compose.yaml up --build
```

Open `http://127.0.0.1:8080`. The host port is localhost-only; PostgreSQL is not published on the host.

For host access to PostgreSQL during development only:

```bash
docker compose -f infra/compose.yaml -f infra/compose.postgres.yaml up -d
```

**Do not use `compose.postgres.yaml` in production.**

## Display timezone

Set `DISPLAY_TIMEZONE` in `.env` to an IANA timezone, for example `Europe/Berlin`.
It controls all dates shown in the web app and how date/time inputs are interpreted; invalid
or missing values use UTC. Schedule timezone remains configurable per query. Database, API,
and LogScale timestamps stay UTC.

## Production

See [docs/installation.md](docs/installation.md) for secrets, external PostgreSQL, volumes, and first bootstrap.

| Topic | Guide |
| --- | --- |
| Install, image & upgrade | [docs/installation.md](docs/installation.md) |
| Security & encryption | [docs/security.md](docs/security.md) |
| Remote access (VPN / NGINX) | [docs/remote-access.md](docs/remote-access.md) |
| LogScale token setup | [docs/logscale-setup.md](docs/logscale-setup.md) |
| Retention policy and deletion | [docs/retention.md](docs/retention.md) |
| Backup & restore | [docs/backup-restore.md](docs/backup-restore.md) |

Production stack:

```bash
export DATABASE_URL='postgres://user:pass@db.example:5432/archive?sslmode=require'
export ENCRYPTION_KEY='…64 hex chars…'
export SESSION_SECRET='…'
export RECOVERY_SECRET='…'
export INSTANCE_NAME='archive-prod-1'
export ARCHIVE_IMAGE='ghcr.io/itrunsde/logscale-archive@sha256:…'
docker compose -f infra/compose.yaml -f infra/compose.production.yaml -f infra/compose.external-postgres.yaml pull web worker
docker compose -f infra/compose.yaml -f infra/compose.production.yaml -f infra/compose.external-postgres.yaml up -d --no-build web worker
```

Start with [installation.md](docs/installation.md), then secure remote access, add a LogScale connection, create and activate a query, and set backup operations.

## Development

```bash
pnpm install
pnpm lint
pnpm test          # requires PostgreSQL on localhost:5432
pnpm test:e2e      # Playwright
pnpm build
```

## V1 scope (unsupported)

- LDAP/OIDC, multi-tenant isolation, HA clustering
- Live LogScale search from the archive UI (stored results only)
- Non-PostgreSQL databases
- Windows/macOS production hosts

## Release artifacts

Tagged releases publish:

- Immutable container image digest (`ghcr.io/…@sha256:…`)
- `archive-image.sha256` checksum
- `sbom.spdx.json` software bill of materials

Generate SBOM locally: `./scripts/generate-sbom.sh IMAGE_TAG`.
