# LogScale setup

Archive needs a **read-only repository token** for each LogScale connection. Tokens are entered in the admin UI and stored encrypted — not in environment variables.

## Create token

In Falcon LogScale (cloud or self-hosted):

1. Open **Settings → API tokens** (or repository token management).
2. Create a token scoped to the target **repository**.
3. Grant **read/query** permissions only. Avoid ingest, delete, or admin scopes.
4. Copy token once; it cannot be retrieved later.

## Add connection in archive

1. Log in as admin → **Connections** → **Add connection**.
2. Fields:
   - **Name** — label in archive UI
   - **Endpoint** — base URL, e.g. `https://cloud.community.humio.com` or `https://logscale.example.com`
   - **Repository** — repository name
   - **Token** — paste read-only token
3. Click **Validate**. Archive checks:
   - API reachability
   - Repository access
   - Permission warnings if token exceeds read-only

Validation stores encrypted token ciphertext. UI never shows token again.

## Query requirements

Scheduled queries must:

- Target the connected repository
- Use Query Jobs compatible syntax
- For **event** mode: results must include `@id` and `#repo` fields
- For **aggregate** mode: fixed time windows; no silent partial success on cap exceeded

Test query in UI before activation.

## Token rotation

1. Create new token in LogScale.
2. Edit connection in archive (or delete and re-add).
3. Re-validate.

Old token can be revoked in LogScale after validation succeeds.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Validation fails | Endpoint URL, repository name, token not expired |
| Permission warning | Reduce token scopes to read/query |
| Jobs fail after deploy | `ENCRYPTION_KEY` unchanged since token was saved |
| No live search in archive | Expected — V1 searches **stored** results only |

## Security

- Never put LogScale tokens in `.env`, compose files, or config exports.
- Tokens appear in audit metadata only as connection ID/name, never value.
