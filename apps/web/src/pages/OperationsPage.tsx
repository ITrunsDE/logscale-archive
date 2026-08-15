import { FormEvent, useEffect, useState } from "react";

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
  createdAt: string;
  finishedAt: string | null;
};

type OperationsStatus = {
  maintenance: { active: boolean; reason?: string };
  storage: {
    decision: "allow" | "warn" | "block";
    volumes: Array<{ path: string; usedPercent: number }>;
  };
  worker: { ok: boolean; lastSeen: string | null };
  database: { ok: boolean };
  migrations: string[];
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

async function api<T>(
  csrfToken: string,
  url: string,
  init?: RequestInit,
): Promise<T> {
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

export function OperationsPage({ user, csrfToken }: OperationsPageProps) {
  const [status, setStatus] = useState<OperationsStatus | null>(null);
  const [selectedBackupId, setSelectedBackupId] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

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
    void reload().catch(() => setError("Failed to load operations status."));
  }, [csrfToken]);

  async function onCreateBackup() {
    setError(null);
    setMessage(null);
    try {
      await api(csrfToken, "/api/admin/operations/backups", { method: "POST", body: "{}" });
      setMessage("Backup started.");
      await reload();
    } catch {
      setError("Could not create backup.");
    }
  }

  async function onRestore(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setMessage(null);
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
      setMessage(
        `Restore complete. Safety backup ${result.outcome.safetyBackupId.slice(0, 8)}… integrity ${result.outcome.integrityOk ? "ok" : "failed"}.`,
      );
      await reload();
    } catch (caught) {
      const err = caught as { body?: { error?: string } };
      if (err.body?.error === "confirmation_mismatch") {
        setError("Instance name does not match.");
        return;
      }
      setError("Restore failed.");
    }
  }

  return (
    <div className="stack">
      <header>
        <h1>Operations</h1>
        <p className="muted">Signed in as {user.username}</p>
      </header>

      {error ? <p className="error">{error}</p> : null}
      {message ? <p className="muted">{message}</p> : null}

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
            <h2>Versions and jobs</h2>
            <p className="muted">Migrations: {status.migrations.join(", ") || "none"}</p>
            <p className="muted">
              Query runs: {JSON.stringify(status.jobs.queryRuns)} · Exports:{" "}
              {JSON.stringify(status.jobs.exports)} · Backups: {JSON.stringify(status.jobs.backups)}
            </p>
          </section>

          <section className="panel wide-panel stack">
            <h2>Backups</h2>
            <button type="button" onClick={() => void onCreateBackup()}>
              Create backup now
            </button>
            <table>
              <thead>
                <tr>
                  <th>Created</th>
                  <th>Status</th>
                  <th>Checksum</th>
                </tr>
              </thead>
              <tbody>
                {status.backups.map((backup) => (
                  <tr key={backup.id}>
                    <td>{new Date(backup.createdAt).toLocaleString()}</td>
                    <td>{backup.status}</td>
                    <td className="mono">{backup.checksum?.slice(0, 12) ?? "—"}</td>
                  </tr>
                ))}
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
                      {new Date(backup.createdAt).toLocaleString()} ({backup.id.slice(0, 8)})
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
            <button type="submit" className="restore-confirm">
              Restore backup
            </button>
          </form>
        </>
      ) : null}
    </div>
  );
}
