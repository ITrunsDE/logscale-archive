import { FormEvent, useEffect, useState } from "react";
import { useActionFeedback } from "../client/actionFeedback.js";

type AuthUser = {
  id: string;
  username: string;
  role: "admin" | "viewer";
};

type BackupRun = {
  id: string;
  status: string;
  filePath: string | null;
  checksum: string | null;
  errorMessage: string | null;
  sizeBytes: number | null;
  createdAt: string;
  finishedAt: string | null;
};

type QueryRunRow = {
  id: string;
  queryName: string;
  versionNumber: number;
  kind: string;
  status: string;
  failureReason: string | null;
  windowStart: string;
  windowEnd: string;
  finishedAt: string | null;
  createdAt: string;
};

type OperationsStatus = {
  maintenance: { active: boolean; reason?: string };
  storage: {
    decision: "allow" | "warn" | "block";
    volumes: Array<{ path: string; usedPercent: number }>;
  };
  worker: { ok: boolean; lastSeen: string | null };
  database: { ok: boolean };
  appVersion: string;
  jobs: {
    queryRuns: Record<string, number>;
    exports: Record<string, number>;
    backups: Record<string, number>;
  };
  backups: BackupRun[];
};

type OperationsPageProps = {
  user: AuthUser;
  csrfToken: string;
};

async function api<T>(csrfToken: string, url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: "include",
    headers: {
      "content-type": "application/json",
      "x-csrf-token": csrfToken,
      ...(init?.headers ?? {}),
    },
    ...init,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(new Error("request_failed"), { status: response.status, body });
  }
  return body as T;
}

function healthStamp(ok: boolean, label: string): string {
  return ok ? `${label}: ok` : `${label}: down`;
}

function statusStampClass(status: string): string {
  if (status === "complete") {
    return "stamp stamp-complete";
  }
  if (status === "failed") {
    return "stamp stamp-failed";
  }
  if (status === "running" || status === "pending") {
    return "stamp stamp-held";
  }
  return "stamp";
}

function shortenError(message: string | null): string {
  if (!message) {
    return "—";
  }
  const oneLine = message.replace(/\s+/g, " ").trim();
  if (/version mismatch/i.test(oneLine)) {
    return "pg_dump version mismatch (server newer than client)";
  }
  return oneLine.length > 96 ? `${oneLine.slice(0, 93)}…` : oneLine;
}

function formatBytes(bytes: number | null): string {
  if (bytes == null) {
    return "—";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

function JobStatCard({
  title,
  counts,
  onStatusClick,
  selectedStatus,
}: {
  title: string;
  counts: Record<string, number>;
  onStatusClick?: (status: string) => void;
  selectedStatus?: string | null;
}) {
  const entries = Object.entries(counts).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) {
    return (
      <article className="ops-stat-card">
        <h3>{title}</h3>
        <p className="muted">No jobs yet.</p>
      </article>
    );
  }
  return (
    <article className="ops-stat-card">
      <h3>{title}</h3>
      {entries.map(([status, count]) => {
        const clickable = Boolean(onStatusClick) && count > 0;
        const open = selectedStatus === status;
        const alert = status === "failed" && count > 0;
        const className = `ops-stat-row${alert ? " alert" : ""}${clickable ? " ops-stat-link" : ""}${open ? " open" : ""}`;
        if (clickable) {
          return (
            <button
              key={status}
              type="button"
              className={className}
              onClick={() => onStatusClick?.(status)}
            >
              <span>{status}</span>
              <span className="mono">{count.toLocaleString()}</span>
            </button>
          );
        }
        return (
          <div key={status} className={`ops-stat-row${alert ? " alert" : ""}`}>
            <span>{status}</span>
            <span className="mono">{count.toLocaleString()}</span>
          </div>
        );
      })}
    </article>
  );
}

export function OperationsPage({ user, csrfToken }: OperationsPageProps) {
  const flash = useActionFeedback();
  const [status, setStatus] = useState<OperationsStatus | null>(null);
  const [selectedBackupId, setSelectedBackupId] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [runsStatus, setRunsStatus] = useState<string | null>(null);
  const [runs, setRuns] = useState<QueryRunRow[] | null>(null);

  async function reload() {
    const result = await api<{ backups: BackupRun[] } & OperationsStatus>(
      csrfToken,
      "/api/admin/operations/status",
    );
    setStatus(result);
    if (!selectedBackupId && result.backups.length > 0) {
      setSelectedBackupId(result.backups.find((b) => b.status === "complete")?.id ?? "");
    }
  }

  useEffect(() => {
    void reload().catch(() => flash.err("Failed to load operations status."));
  }, [csrfToken]);

  // Keep job counts fresh while page is open.
  useEffect(() => {
    const timer = window.setInterval(() => {
      void reload().catch(() => {});
      if (!runsStatus) {
        return;
      }
      void api<{ runs: QueryRunRow[] }>(
        csrfToken,
        `/api/admin/operations/query-runs?status=${encodeURIComponent(runsStatus)}`,
      )
        .then((result) => setRuns(result.runs))
        .catch(() => {});
    }, 5000);
    return () => window.clearInterval(timer);
  }, [csrfToken, runsStatus]);

  async function loadRuns(statusFilter: string) {
    flash.busy(`Loading ${statusFilter} runs…`, "query-runs");
    try {
      const result = await api<{ runs: QueryRunRow[] }>(
        csrfToken,
        `/api/admin/operations/query-runs?status=${encodeURIComponent(statusFilter)}`,
      );
      setRuns(result.runs);
      setRunsStatus(statusFilter);
      flash.clear();
    } catch {
      flash.err(`Could not load ${statusFilter} query runs.`);
    }
  }

  function onToggleRuns(statusFilter: string) {
    if (runsStatus === statusFilter) {
      setRunsStatus(null);
      setRuns(null);
      return;
    }
    void loadRuns(statusFilter);
  }

  async function onCreateBackup() {
    flash.busy("Starting backup…", "backup");
    try {
      await api(csrfToken, "/api/admin/operations/backups", { method: "POST", body: "{}" });
      flash.ok("Backup started.");
      await reload();
    } catch (caught) {
      const err = caught as { body?: { message?: string } };
      flash.err(err.body?.message ?? "Could not create backup.");
      await reload();
    }
  }

  async function onClearFailed() {
    const failed = status?.jobs.backups.failed ?? 0;
    if (failed <= 0) {
      return;
    }
    const ok = window.confirm(`Delete ${failed.toLocaleString()} failed backup record(s)?`);
    if (!ok) {
      return;
    }
    flash.busy("Clearing failed backups…", "clear");
    try {
      const result = await api<{ deleted: number }>(
        csrfToken,
        "/api/admin/operations/backups/clear-failed",
        { method: "POST", body: "{}" },
      );
      flash.ok(`Cleared ${result.deleted.toLocaleString()} failed backup(s).`);
      await reload();
    } catch {
      flash.err("Could not clear failed backups.");
    }
  }

  async function onRestore(event: FormEvent) {
    event.preventDefault();
    flash.busy("Restoring backup…", "restore");
    try {
      const result = await api<{ outcome: { safetyBackupId: string; integrityOk: boolean } }>(
        csrfToken,
        "/api/admin/operations/restore",
        {
          method: "POST",
          body: JSON.stringify({ backupId: selectedBackupId, confirmation }),
        },
      );
      setConfirmation("");
      flash.ok(
        `Restore complete. Safety backup ${result.outcome.safetyBackupId.slice(0, 8)}… integrity ${result.outcome.integrityOk ? "ok" : "failed"}.`,
      );
      await reload();
    } catch (caught) {
      const err = caught as { body?: { error?: string } };
      if (err.body?.error === "confirmation_mismatch") {
        flash.err("Instance name does not match.");
        return;
      }
      flash.err("Restore failed.");
    }
  }

  const failedBackupCount = status?.jobs.backups.failed ?? 0;

  return (
    <div className="stack">
      <header>
        <h1>Operations</h1>
        <p className="muted">Signed in as {user.username}</p>
      </header>

      {status ? (
        <>
          <section className="panel wide-panel stack">
            <h2>Health</h2>
            <div className="health-stamps">
              <span
                className={
                  status.storage.decision === "block"
                    ? "stamp stamp-failed"
                    : status.storage.decision === "warn"
                      ? "stamp stamp-held"
                      : "stamp stamp-complete"
                }
              >
                {healthStamp(status.storage.decision !== "block", "Disk")}
              </span>
              <span className={status.worker.ok ? "stamp stamp-complete" : "stamp stamp-failed"}>
                {healthStamp(status.worker.ok, "Worker")}
              </span>
              <span className={status.database.ok ? "stamp stamp-complete" : "stamp stamp-failed"}>
                {healthStamp(status.database.ok, "Database")}
              </span>
            </div>
            {status.maintenance.active ? (
              <p className="error">Maintenance: {status.maintenance.reason ?? "active"}</p>
            ) : null}
            <ul>
              {status.storage.volumes.map((volume) => (
                <li key={volume.path}>
                  {volume.path}: {volume.usedPercent.toFixed(1)}% used
                </li>
              ))}
            </ul>
          </section>

          <section className="panel wide-panel stack">
            <h2>Jobs</h2>
            <div className="ops-stat-grid">
              <JobStatCard
                title="Query runs"
                counts={status.jobs.queryRuns}
                onStatusClick={onToggleRuns}
                selectedStatus={runsStatus}
              />
              <JobStatCard title="Exports" counts={status.jobs.exports} />
              <JobStatCard title="Backups" counts={status.jobs.backups} />
            </div>
            {runsStatus ? (
              <div className="ops-failed-panel stack">
                <div className="ops-toolbar">
                  <h3>
                    Query runs: <span className="mono">{runsStatus}</span>
                  </h3>
                  <button type="button" className="secondary" onClick={() => { setRunsStatus(null); setRuns(null); }}>
                    Close
                  </button>
                </div>
                {runs == null ? (
                  <p className="muted">Loading…</p>
                ) : runs.length === 0 ? (
                  <p className="muted">No {runsStatus} runs.</p>
                ) : (
                  <table>
                    <thead>
                      <tr>
                        <th>When</th>
                        <th>Query</th>
                        <th>Kind</th>
                        <th>Window</th>
                        {runsStatus === "failed" ? <th>Error</th> : null}
                      </tr>
                    </thead>
                    <tbody>
                      {runs.map((run) => (
                        <tr key={run.id}>
                          <td>{new Date(run.finishedAt ?? run.createdAt).toLocaleString()}</td>
                          <td className="mono">
                            {run.queryName} v{run.versionNumber}
                          </td>
                          <td>{run.kind}</td>
                          <td className="mono">
                            {new Date(run.windowStart).toLocaleString()} →{" "}
                            {new Date(run.windowEnd).toLocaleString()}
                          </td>
                          {runsStatus === "failed" ? (
                            <td>
                              {run.failureReason ? (
                                <span className="ops-error" title={run.failureReason}>
                                  {shortenError(run.failureReason)}
                                </span>
                              ) : (
                                <span className="muted">—</span>
                              )}
                            </td>
                          ) : null}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            ) : null}
          </section>

          <section className="panel wide-panel stack">
            <div className="ops-toolbar">
              <h2>Backups</h2>
              <div className="row-actions">
                <button
                  type="button"
                  disabled={flash.anyBusy}
                  aria-busy={flash.isBusy("backup")}
                  onClick={() => void onCreateBackup()}
                >
                  {flash.isBusy("backup") ? "Starting…" : "Create backup now"}
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={flash.anyBusy || failedBackupCount === 0}
                  aria-busy={flash.isBusy("clear")}
                  onClick={() => void onClearFailed()}
                >
                  {flash.isBusy("clear") ? "Clearing…" : "Clear failed"}
                </button>
              </div>
            </div>
            <table>
              <thead>
                <tr>
                  <th>Created</th>
                  <th>Status</th>
                  <th>Size</th>
                  <th>Checksum</th>
                  <th>Error</th>
                </tr>
              </thead>
              <tbody>
                {status.backups.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="muted">
                      No backups yet.
                    </td>
                  </tr>
                ) : (
                  status.backups.map((backup) => (
                    <tr key={backup.id}>
                      <td>{new Date(backup.createdAt).toLocaleString()}</td>
                      <td>
                        <span className={statusStampClass(backup.status)}>{backup.status}</span>
                      </td>
                      <td className="mono">{formatBytes(backup.sizeBytes)}</td>
                      <td className="mono">{backup.checksum?.slice(0, 12) ?? "—"}</td>
                      <td>
                        {backup.errorMessage ? (
                          <span className="ops-error" title={backup.errorMessage}>
                            {shortenError(backup.errorMessage)}
                          </span>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </section>

          <form className="panel wide-panel stack restore-danger" onSubmit={onRestore}>
            <h2>Dangerous restore</h2>
            <p className="muted">
              Restores replace the live database. A safety backup is taken first. Type the instance
              name to confirm.
            </p>
            <label>
              Backup
              <select
                value={selectedBackupId}
                onChange={(event) => setSelectedBackupId(event.target.value)}
                required
              >
                <option value="" disabled>
                  Select backup
                </option>
                {status.backups
                  .filter((backup) => backup.status === "complete")
                  .map((backup) => (
                    <option key={backup.id} value={backup.id}>
                      {new Date(backup.createdAt).toLocaleString()} · {formatBytes(backup.sizeBytes)} (
                      {backup.id.slice(0, 8)})
                    </option>
                  ))}
              </select>
            </label>
            <label>
              Instance name
              <input
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                required
                autoComplete="off"
              />
            </label>
            <button
              type="submit"
              className="restore-confirm"
              disabled={flash.anyBusy}
              aria-busy={flash.isBusy("restore")}
            >
              {flash.isBusy("restore") ? "Restoring…" : "Restore backup"}
            </button>
          </form>
        </>
      ) : null}
    </div>
  );
}
