# Query UX Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Next-run display, Queries-hosted backfill with datetime-local, cron default persistence, Results viewport scroll.

**Architecture:** Extend `listQueryVersions` with schedule join; harden draft save default cron; relocate Retention backfill UI into QueryEditorPage; CSS-only Results scroll fix.

**Tech Stack:** TypeScript, React, Vitest, Fastify, Postgres

**Spec:** `docs/superpowers/specs/2026-08-15-query-ux-polish-design.md`

## Global Constraints

- Do **not** run integration tests against DEV01 production `DATABASE_URL`
- No new npm date-picker deps
- Backfill API routes unchanged (UI move only)

---

### Task 1: nextRunAt + cron default (core)

**Files:**
- Modify: `packages/core/src/queries/queryVersions.ts`
- Test: `tests/unit/query-names.test.ts` or small unit/integration with mocked/isolated DB

- [ ] Expose `nextRunAt` on listed versions
- [ ] Empty cron on draft create → `0 * * * *`

### Task 2: QueryEditorPage UI

**Files:**
- Modify: `apps/web/src/pages/QueryEditorPage.tsx`
- Modify: `apps/web/src/pages/RetentionPage.tsx` (remove backfill)
- Modify: `apps/web/src/client/styles.css` as needed

- [ ] Show next run in version list
- [ ] Backfill block with datetime-local
- [ ] Cron hint + load default

### Task 3: Results scroll CSS

**Files:**
- Modify: `apps/web/src/client/styles.css`

- [ ] `.table-scroll` max-height + sticky thead
