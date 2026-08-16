# Retention

Retention deletes archived database records for one query version. It does not change Falcon LogScale source data.

## Set retention on a query version

Open **Queries**, select a version, then open **Schedule & retention**.

| Field | Meaning |
| --- | --- |
| **Retention days** | Keep archived data for this many full days. Empty means keep it indefinitely. |
| **Schedule cron** | When this version archives new data; it does not control deletion. |
| **Schedule timezone** | Timezone used for the archive schedule. |
| **Initial start** | Beginning of the first archive window. |
| **Correction window** | Recent seconds re-read on every run to catch late-arriving LogScale events. |

For example, `30` keeps event records whose timestamps are within the last 30 days. Aggregate snapshots use their window end time. Retention applies to the selected version, including inactive versions.

Worker applies retention automatically. **Retention days** only removes database event records and aggregate snapshots; it does not delete LogScale source data or export files.

## Retention page

| Section | Use |
| --- | --- |
| **Storage** | Admission state for new archive work. `warn` means space is low; `block` stops new archive jobs. Retention can still free space. |
| **Retention holds** | Versions protected from automatic retention deletion. |
| **Add hold** | Select a query version; record a reason such as an audit or legal case. |
| **Apply retention now** | Runs normal retention immediately for all versions with a retention period, except held versions. |
| **Manual delete** | Immediately removes data from one selected version. |

Each selector shows `connection · query name · version`. Query versions are separate retention policies: a new version can have a different period from an older version.

## Holds and manual deletion

A hold prevents only automatic retention deletion. **Release** makes the version eligible again on the next retention run.

**Manual delete ignores holds.** Use it only when deletion is intentional and approved.

`Before` accepts an ISO timestamp, for example `2026-08-01T00:00:00Z`; data older than that instant is deleted. Leave it blank to delete all archived event and aggregate data for the selected version.

## Safe operating sequence

1. Set **Retention days** on a new query version and save it.
2. Add a hold before retention if records must be preserved.
3. Confirm version and timestamp before manual deletion.
4. Use [backup-restore.md](backup-restore.md) before destructive maintenance.
