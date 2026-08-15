# Inactive query usage — design

Date: 2026-08-15

## Goal

Clarify what “deactivated query” means for Results, Export, and Retention: stop LogScale ingest, keep archive access.

## Decisions

| Surface | Inactive version |
|---|---|
| Results search / list | Allowed (include in picker) |
| Export of stored data | Allowed |
| Retention hold | Allowed |
| Manual retention delete | Allowed |
| Backfill create / resume | **Blocked** |
| Scheduled ingest | Already blocked (`active = true` filters + deactivate pauses schedule) |

## Behavior

### Deactivate (existing)

- Sets `query_versions.active = false`
- Pauses schedule, cancels pending/running runs, pauses pending backfill windows

### Backfill (new)

- `createBackfill` and `resumeBackfill` reject when version is inactive
- Error: `inactive_query` → HTTP 409
- `pauseBackfill` / status remain allowed

### Results list (change)

- `listSearchableQueryVersions` returns active **and** inactive versions
- Response includes `active` so UI can label inactive
- Search API unchanged (still works by version id)

### Unchanged

- Export create, retention holds, manual delete
- Worker lease/scheduler active filters

## Out of scope

- Central policy middleware for all routes
- Export page query picker redesign
- Blocking search/export of archived rows for inactive versions

## Tests

1. `createBackfill` on inactive version → `inactive_query`
2. `resumeBackfill` on inactive version → `inactive_query`
3. `listSearchableQueryVersions` includes inactive row with `active: false`
