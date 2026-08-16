# Remote access

Web defaults to **localhost only**. Choose one pattern below.

## VPN (recommended)

1. Deploy archive on a private host (no public ports).
2. Operators reach the host via VPN (WireGuard, Tailscale, corporate VPN, etc.).
3. Browse `http://127.0.0.1:8080` on the host via SSH tunnel, or bind web to VPN interface only:

```bash
# Example: listen on Tailscale IP only (advanced — adjust compose ports)
# Keep postgres unpublished.
```

SSH tunnel from workstation:

```bash
ssh -L 8080:127.0.0.1:8080 archive-host
# open http://127.0.0.1:8080 locally
```

No LogScale or PostgreSQL traffic crosses the tunnel unless you explicitly forward those ports (don't).

## NGINX / operator-managed public access

For HTTPS on a public hostname, terminate TLS in front of web only.

### Compose NGINX profile

```bash
export NGINX_CERT_PATH=/etc/logscale-archive/nginx-certs
docker compose \
  -f infra/compose.yaml \
  -f infra/compose.production.yaml \
  -f infra/compose.external-postgres.yaml \
  -f infra/compose.nginx.yaml \
  --profile nginx up -d --no-build
```

`NGINX_CERT_PATH` must contain `fullchain.pem` and `privkey.pem`. `infra/nginx/nginx.conf.example` proxies **web only**. It does not expose worker or postgres.

Checklist:

- [ ] Valid TLS certificates on NGINX
- [ ] Web host port remains localhost-only; NGINX publishes 443
- [ ] `SECURE_COOKIES=true` (set in production overrides)
- [ ] Restrict admin paths by IP or add SSO at proxy (V1 has no built-in SSO)

### External reverse proxy

Point upstream to `127.0.0.1:8080` on the archive host. Forward:

- `Host`
- `X-Forwarded-For`
- `X-Forwarded-Proto`

Example upstream block is in `infra/nginx/nginx.conf.example`.

## What not to expose

| Service | Host port |
| --- | --- |
| PostgreSQL | Never |
| Worker | Never |
| Web | Localhost default; public only via NGINX/proxy |

## Firewall

Minimum production rules:

- Allow SSH/VPN from admin networks
- Allow 443 to NGINX if public UI required
- Deny all other inbound

LogScale API calls originate from **worker** outbound to your LogScale endpoint — no inbound LogScale ports needed.
