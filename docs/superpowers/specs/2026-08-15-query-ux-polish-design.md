# Query UX polish — design

Date: 2026-08-15

## Goal

Make schedule/backfill/results operable without raw ISO/UUID gymnastics.

## Decisions

| Topic | Choice |
|---|---|
| Scope | One pass: next run, backfill move, cron default, results scroll |
| Next run | Version list only |
| Backfill | Queries page; remove from Retention |
| Date/time | Native `datetime-local` → API ISO UTC |
| Cron default | `0 * * * *` / timezone `UTC`; empty on save → default |

## Behavior

### Next run

- `listQueryVersions` includes `nextRunAt: string | null` from `query_schedules.next_run_at`
- Version list shows human-readable UTC time or `—`

### Backfill on Queries

- Shown for selected version when `mode === "event"`
- Disabled when inactive (existing API `inactive_query`)
- Fields: start/end `datetime-local`, create / pause / resume, status counts
- Help text: UTC day windows; fills missing history from LogScale
- Retention page: delete backfill UI only

### Cron default

- New draft and blank schedule field: `0 * * * *`, timezone `UTC`
- Persist: trim empty cron → store `0 * * * *` (not null)
- Hint under field

### Results scroll

- `.table-scroll` capped to viewport (`max-height: calc(100dvh - …)`)
- Sticky table header; overflow auto keeps scrollbars in panel

## Out of scope

- Date-picker libraries
- Virtualized results grid
- Moving hold/delete off Retention

## Tests

1. `listQueryVersions` returns `nextRunAt` when schedule row exists
2. Draft create with empty cron stores `0 * * * *`
3. (Manual / CSS) Results panel scrolls inside viewport
