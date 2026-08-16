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
   - **Endpoint** — API base URL only, e.g. `https://cloud.community.humio.com` (no `/humio`, no `/api/v1`)
   - **Repository** — repository name
   - **Token** — paste read-only token
3. Click **Save connection**. Archive stores the encrypted token and **validates immediately** (reachability, repository access, permission warnings).

UI never shows the token again. Use **Edit** to change name/endpoint/repository; leave token blank to keep the stored one. Edit also validates immediately.

## Query requirements

Scheduled queries must:

- Target the connected repository
- Use Query Jobs compatible syntax
- For **event** mode: results must include `@id` and `#repo` fields
- For **aggregate** mode: fixed time windows (`timeChart`, `bucket`, or `span`); no silent partial success on cap exceeded
- Not contain `head()` or numeric `tail()`; archive controls result limits

Test query in UI before activation.

## Create first archive

1. Open **Queries** and create a query with its connection, mode, and query text.
2. Under **Schedule & retention**, set cron, timezone, optional initial start, correction window, and retention period. Default schedule is hourly UTC.
3. Save draft, select its version, then run **Test**.
4. Activate only after test passes. Worker creates scheduled archive runs.
5. Use **Results** for stored data, **Exports** for asynchronous files, **Operations** for run and backup status, and [retention.md](retention.md) for retention and deletion.

For event queries, **Fill history** creates a backfill after activation. Aggregate queries do not support backfill.

## Token rotation

1. Create new token in LogScale.
2. **Edit** connection → paste new token → save (auto-validates).
3. Revoke old token in LogScale after status is valid.

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
