# Security

## Network

- **Default:** web binds `127.0.0.1:8080` — localhost only.
- **PostgreSQL:** never published in production compose. Worker has no host ports.
- **Remote access:** VPN to host, or NGINX/operator TLS in front of web ([remote-access.md](remote-access.md)).

## Secrets

| Secret | Storage | Rotation |
| --- | --- | --- |
| LogScale repository token | Encrypted in DB (`ENCRYPTION_KEY`) | Re-enter in UI; old ciphertext unusable after key rotation |
| `ENCRYPTION_KEY` | Env or Docker secret | Requires re-encrypting all connections; plan downtime |
| `SESSION_SECRET` | Env or Docker secret | Invalidates all sessions on change |
| `RECOVERY_SECRET` | Env or Docker secret | Required for break-glass recovery CLI |
| `DATABASE_URL` | Env or Docker secret | Contains DB password |

Never commit `.env`, secret files, or config exports with tokens.

## Encryption responsibilities

**You must provide:**

- `ENCRYPTION_KEY` at deploy time (64 hex chars).
- Host/volume encryption for PostgreSQL data, backup mount, and export volume (LUKS, cloud disk encryption, etc.).

The application encrypts LogScale tokens at rest. It does **not** encrypt PostgreSQL table data or backups beyond what PostgreSQL/host storage provides.

## TLS

- External `DATABASE_URL` must use `sslmode=require` (or `verify-ca` / `verify-full`) when `REQUIRE_DB_TLS=true`.
- Browser sessions use `Secure` cookies when not bound to localhost (`SECURE_COOKIES=true` in production overrides).
- Terminate HTTPS at NGINX or upstream load balancer; set `X-Forwarded-Proto`.

## Authentication

- Local accounts only (Argon2id, HTTP-only session cookie, CSRF on API).
- Recovery admin CLI: `RECOVERY_SECRET` + `APP_ROLE=web node apps/web/dist/recovery.js …`
- Failed login rate limiting enabled.

## Audit & logging

- Admin actions write metadata-only audit rows (no result payloads, no tokens).
- Application logs must not contain API tokens or archived event payloads.

## Hardening checklist

- [ ] Secrets from vault/secret manager, not shell history
- [ ] Firewall: only required ports (443 via NGINX if public)
- [ ] Encrypted backups at rest
- [ ] Regular restore tests ([backup-restore.md](backup-restore.md))
- [ ] Pin container image by digest

## V1 limits

No SSO, no built-in WAF, no automatic key rotation. Operator owns host OS patching and intrusion detection.
