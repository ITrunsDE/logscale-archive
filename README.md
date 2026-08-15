# LogScale Archive

Self-hosted archive for scheduled Falcon LogScale queries. Stores results in PostgreSQL and exposes a local web UI for administration, search, and export.

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

Open `http://127.0.0.1:8080`. Web binds to localhost; PostgreSQL is not published on the host.

For host access to PostgreSQL during development only:

```bash
docker compose -f infra/compose.yaml -f infra/compose.postgres.yaml up -d
```

**Do not use `compose.postgres.yaml` in production.**

## Production

See [docs/installation.md](docs/installation.md) for secrets, external PostgreSQL, volumes, and first bootstrap.

| Topic | Guide |
| --- | --- |
| Install & upgrade | [docs/installation.md](docs/installation.md) |
| Security & encryption | [docs/security.md](docs/security.md) |
| Backup & restore | [docs/backup-restore.md](docs/backup-restore.md) |
| Remote access (VPN / NGINX) | [docs/remote-access.md](docs/remote-access.md) |
| LogScale token setup | [docs/logscale-setup.md](docs/logscale-setup.md) |

Production stack:

```bash
export DATABASE_URL='postgres://user:pass@db.example:5432/archive?sslmode=require'
export ENCRYPTION_KEY='…64 hex chars…'
export SESSION_SECRET='…'
export RECOVERY_SECRET='…'
docker compose -f infra/compose.yaml -f infra/compose.production.yaml up -d web worker
```

Pin releases to an immutable digest from GitHub Releases (checksum + SBOM attached).

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
