# Backup and restore

## Backup mount

Set `BACKUP_PATH` (default `/data/backups` in production overrides). Worker writes `pg_dump` output here with SHA-256 checksums recorded in the database.

Mount persistent storage:

```yaml
volumes:
  - /secure/backups:/data/backups
```

Encrypt the backup volume at the host/storage layer.

## Scheduled backups

Worker runs scheduled backups when not in maintenance mode. Status appears on **Operations** in the UI.

## Manual backup

```bash
export DATABASE_URL='…'
export BACKUP_PATH=/data/backups
./infra/scripts/backup.sh
```

## Restore (UI)

Admin-only workflow on **Operations**:

1. Select backup.
2. Type instance name to confirm.
3. System creates a **safety backup** before restore.
4. Maintenance mode blocks new jobs during restore.
5. All sessions invalidated after restore.

## Restore (CLI)

```bash
export DATABASE_URL='…'
./infra/scripts/restore.sh /data/backups/archive-….sql
```

Stop worker during manual restore. Re-run migrations if needed via web startup.

## Restore test (required)

Periodically verify backups on a disposable host:

1. Restore latest backup to a scratch PostgreSQL instance.
2. Start web against scratch DB.
3. Confirm user count, query versions, and sample archived results.
4. Delete scratch environment.

A failed restore test is worse than no backup.

## Update guard

Schema migrations on upgrade require a **recent successful backup**. If none exists, web refuses migration until backup succeeds.

## Exports

Export files live under `EXPORT_PATH` and are excluded from DB backups. Re-create exports after restore if needed.

## What backups contain

- PostgreSQL logical dump (config, users, archived results metadata, audit)
- **Not** export files on disk (separate volume)

Keep `ENCRYPTION_KEY` safe — restored DB token ciphertext requires the same key.
