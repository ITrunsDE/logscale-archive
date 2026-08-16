# Installation

This guide installs LogScale Archive on a Linux x86_64 host with Docker Compose v2. When you finish the steps, the web UI is at `http://127.0.0.1:8080`.

Local evaluation only? Use the short path in [README.md](../README.md): copy `.env.example` to `.env` and run `docker compose -f infra/compose.yaml up --build`.

## What you need

- Linux host (x86_64 / amd64). Windows and macOS are not supported for production.
- Docker Engine and Docker Compose v2
- Terminal access on that host
- A release of [logscale-archive](https://github.com/ITrunsDE/logscale-archive/releases) (for the image digest)

Check:

```bash
uname -m          # must be x86_64 or amd64
docker --version
docker compose version
```

## Step 1 — Clone the repository

```bash
git clone https://github.com/ITrunsDE/logscale-archive.git
cd logscale-archive
```

Run every later command from this directory.

## Step 2 — Create secrets

```bash
cp .env.example .env
```

Compose files live in `infra/`. Docker Compose therefore does not load this repo-root `.env` unless every command includes `--env-file .env`.

Generate secrets (do not keep the example values). `ENCRYPTION_KEY` must be **hex**, not the base64 output:

```bash
# ENCRYPTION_KEY — exactly 64 hex characters
openssl rand -hex 32

# SESSION_SECRET
openssl rand -base64 32

# RECOVERY_SECRET
openssl rand -base64 32
```

Open `.env` and set:

| Variable | What to put |
| --- | --- |
| `POSTGRES_PASSWORD` | A strong password of your own |
| `ENCRYPTION_KEY` | First command only (`openssl rand -hex 32`). Must be 64 characters `0-9`/`a-f`. Base64 from the other commands will fail at start. |
| `SESSION_SECRET` | Second random output, at least 32 characters |
| `RECOVERY_SECRET` | Third random output |
| `INSTANCE_NAME` | Short name, for example `archive-prod-1` (required later to confirm a restore) |

Never change `ENCRYPTION_KEY` after you save LogScale connections in the UI. Stored tokens become unreadable.

## Step 3 — Set the database URL (bundled PostgreSQL)

You still need `DATABASE_URL` even if you do **not** run your own PostgreSQL. The bundled database is a Docker container named `postgres` on this host. Production Compose requires this variable; without it, start fails.

This happy path uses that bundled container. For a managed database, skip to [External PostgreSQL](#external-postgresql).

Add both lines to `.env` (do not leave `DATABASE_URL` empty):

```dotenv
DATABASE_URL=postgres://archive:YOUR_POSTGRES_PASSWORD@postgres:5432/archive
REQUIRE_DB_TLS=false
SECURE_COOKIES=false
```

`YOUR_POSTGRES_PASSWORD` must match `POSTGRES_PASSWORD` exactly. If the password contains special characters, URL-encode them in `DATABASE_URL`.

`SECURE_COOKIES=false` is required while you use HTTP (including `http://127.0.0.1:8080`). Production defaults to `true`, which drops the login cookie on HTTP. Set `SECURE_COOKIES=true` when you terminate HTTPS (see NGINX below).

## Step 4 — Pin the release image

1. Open [GitHub Releases](https://github.com/ITrunsDE/logscale-archive/releases).
2. Copy the digest (`sha256:…`) from the release notes.
3. Put it in `.env`. The registry path **must be lowercase** (`itrunsde`, not `ITrunsDE`). Docker rejects mixed-case names:

```dotenv
ARCHIVE_IMAGE=ghcr.io/itrunsde/logscale-archive@sha256:PASTE_DIGEST
```

Without `ARCHIVE_IMAGE`, Compose tries to build locally. Production should pull the release image. Images are public. Optional: verify `archive-image.sha256` and `sbom.spdx.json` from the same release.

## Step 5 — Start the containers

```bash
docker compose --env-file .env \
  -f infra/compose.yaml \
  -f infra/compose.production.yaml \
  --profile bundled-db \
  pull web worker postgres

docker compose --env-file .env \
  -f infra/compose.yaml \
  -f infra/compose.production.yaml \
  --profile bundled-db \
  up -d --no-build
```

Migrations run automatically on web startup.

Containers are named `logscale-archive-web-1`, `logscale-archive-worker-1`, and `logscale-archive-postgres-1`.

## Step 6 — Check that it is up

```bash
curl -sf http://127.0.0.1:8080/healthz && echo OK
```

Expect `OK`. If not:

```bash
docker compose --env-file .env -f infra/compose.yaml -f infra/compose.production.yaml --profile bundled-db ps
docker compose --env-file .env -f infra/compose.yaml -f infra/compose.production.yaml --profile bundled-db logs web --tail 80
```

## Step 7 — Create the first admin

Open `http://127.0.0.1:8080` and complete the first-admin form, then sign in.

The UI listens on this host only (localhost). Access from another machine: [remote-access.md](remote-access.md).

## Step 8 — Connect LogScale

Create a read-only repository token in LogScale and save it under **Connections** in the UI. See [logscale-setup.md](logscale-setup.md). Then create a query, test it, and activate it.

Day-to-day backups: [backup-restore.md](backup-restore.md).

---

## Optional — HTTPS with NGINX

Use this only when the UI must be reachable on a public hostname over HTTPS. Without NGINX the UI stays at `http://127.0.0.1:8080` on this host.

NGINX publishes port 443. PostgreSQL and the worker stay unpublished.

### N1 — Set the hostname

Edit `infra/nginx/nginx.conf.example`. Change `server_name` to your hostname, for example:

```
server_name archive.example.com;
```

### N2 — Place TLS certificates

Put these two files in a directory on the host, for example `/etc/logscale-archive/nginx-certs/`:

- `fullchain.pem`
- `privkey.pem`

```bash
sudo mkdir -p /etc/logscale-archive/nginx-certs
# copy the certificate files into that directory, then:
sudo chmod 600 /etc/logscale-archive/nginx-certs/privkey.pem
```

Add to `.env`:

```dotenv
NGINX_CERT_PATH=/etc/logscale-archive/nginx-certs
SECURE_COOKIES=true
```

### N3 — Restart with NGINX

Bundled PostgreSQL (happy path):

```bash
docker compose --env-file .env \
  -f infra/compose.yaml \
  -f infra/compose.production.yaml \
  -f infra/compose.nginx.yaml \
  --profile bundled-db \
  --profile nginx \
  up -d --no-build
```

External PostgreSQL: add `-f infra/compose.external-postgres.yaml` and omit `--profile bundled-db`.

### N4 — Check

Open `https://your-hostname`. Allow inbound 443 (and SSH/VPN). Keep port 8080 on localhost.

Checklist and VPN alternative: [remote-access.md](remote-access.md).

---

## External PostgreSQL

Recommended when you already run managed PostgreSQL 16. TLS is required.

1. Create a database and role with full access to that database.
2. Complete [Step 1](#step-1--clone-the-repository), [Step 2](#step-2--create-secrets), and [Step 4](#step-4--pin-the-release-image). Skip Step 3.
3. Set in `.env`:

```dotenv
DATABASE_URL=postgres://archive:SECRET@db.example:5432/archive?sslmode=require
REQUIRE_DB_TLS=true
```

`REQUIRE_DB_TLS=true` is the production default.

4. Pull and start web + worker (no bundled postgres):

```bash
docker compose --env-file .env \
  -f infra/compose.yaml \
  -f infra/compose.production.yaml \
  -f infra/compose.external-postgres.yaml \
  pull web worker

docker compose --env-file .env \
  -f infra/compose.yaml \
  -f infra/compose.production.yaml \
  -f infra/compose.external-postgres.yaml \
  up -d --no-build web worker
```

5. Continue from [Step 6](#step-6--check-that-it-is-up).

If operations logging is enabled, add `-f infra/compose.logging.yaml` after `infra/compose.external-postgres.yaml`.

Never publish PostgreSQL to the host. Base `infra/compose.yaml` keeps postgres internal. `infra/compose.postgres.yaml` is **local development only** (binds `127.0.0.1:5432`).

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
2. Confirm a recent successful backup in Operations (the update guard blocks migration otherwise).
3. Set `ARCHIVE_IMAGE` in `.env` to the new release digest, then pull and recreate.

Bundled PostgreSQL:

```bash
docker compose --env-file .env \
  -f infra/compose.yaml \
  -f infra/compose.production.yaml \
  --profile bundled-db \
  pull web worker postgres
docker compose --env-file .env \
  -f infra/compose.yaml \
  -f infra/compose.production.yaml \
  --profile bundled-db \
  up -d --no-build
```

External PostgreSQL:

```bash
docker compose --env-file .env \
  -f infra/compose.yaml \
  -f infra/compose.production.yaml \
  -f infra/compose.external-postgres.yaml \
  pull web worker
docker compose --env-file .env \
  -f infra/compose.yaml \
  -f infra/compose.production.yaml \
  -f infra/compose.external-postgres.yaml \
  up -d --no-build web worker
```

If NGINX or operations logging is in use, keep the same extra `-f` files and `--profile` flags as at install time.

4. Watch web logs for migration completion.

## Optional — operations logging

Operations events are JSON on stdout by default. Direct LogScale delivery is optional.

1. Create a separate LogScale repository, for example `logscale-archive-ops`.
2. Create an **ingest token** for that repository. It must not be the read token used by an archive connection.
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

   `LOGSCALE_LOG_ENDPOINT` is the LogScale base URL, for example `https://cloud.community.humio.com`. It is not a repository URL. The ingest token selects the target repository.

5. Start with `infra/compose.logging.yaml`. It mounts the token into both containers; the token never appears in Compose or `.env`.

Bundled PostgreSQL:

```bash
docker compose --env-file .env \
  -f infra/compose.yaml \
  -f infra/compose.production.yaml \
  -f infra/compose.logging.yaml \
  --profile bundled-db \
  pull web worker postgres
docker compose --env-file .env \
  -f infra/compose.yaml \
  -f infra/compose.production.yaml \
  -f infra/compose.logging.yaml \
  --profile bundled-db \
  up -d --no-build
```

External PostgreSQL: add `-f infra/compose.external-postgres.yaml` after `compose.production.yaml`, omit `--profile bundled-db`, and start `web worker` only.

Delivery is best effort. Events include service, lifecycle and query-run metadata; they exclude query text, result payloads, audit entries and HTTP request logs. Every operations event has `app=logscale-archive`, suitable for LogScale dashboards.

## Optional — Docker secret files

Mount files and set `*_FILE` paths. The entrypoint reads them into env:

```yaml
environment:
  DATABASE_URL_FILE: /run/secrets/database_url
secrets:
  - database_url
```

## Event archive result limit

`LOGSCALE_EVENT_TAIL_LIMIT=1000` is the default per-query event limit. It reduces backfill splitting for busy repositories while preserving pagination. The collector adds `tail(...)`; scheduled query text must not add a numeric `tail(...)` itself.

## Secrets reference

Production overrides require these. No production defaults.

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string |
| `ENCRYPTION_KEY` | 64 hex chars (32 bytes); encrypts LogScale tokens at rest |
| `SESSION_SECRET` | Cookie signing secret (≥32 chars recommended) |
| `RECOVERY_SECRET` | Gates break-glass admin recovery CLI |
| `INSTANCE_NAME` | Exact name required to confirm UI restores |

## Unsupported in V1

See [README.md](../README.md#v1-scope-unsupported).
