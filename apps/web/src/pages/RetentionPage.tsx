import { FormEvent, useEffect, useState } from "react";

type AuthUser = {
  id: string;
  username: string;
  role: "admin" | "viewer";
};

type RetentionHold = {
  id: string;
  queryVersionId: string;
  reason: string;
  queryName: string;
  versionNumber: number;
  createdAt: string;
};

type BackfillStatus = {
  pending: number;
  running: number;
  complete: number;
  failed: number;
  paused: number;
};

type StorageStatus = {
  decision: "allow" | "warn" | "block";
  volumes: Array<{ path: string; usedPercent: number }>;
};

type RetentionPageProps = {
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

export function RetentionPage({ user, csrfToken }: RetentionPageProps) {
  const [holds, setHolds] = useState<RetentionHold[]>([]);
  const [storage, setStorage] = useState<StorageStatus | null>(null);
  const [holdQueryVersionId, setHoldQueryVersionId] = useState("");
  const [holdReason, setHoldReason] = useState("");
  const [deleteQueryVersionId, setDeleteQueryVersionId] = useState("");
  const [deleteBefore, setDeleteBefore] = useState("");
  const [backfillQueryVersionId, setBackfillQueryVersionId] = useState("");
  const [backfillStart, setBackfillStart] = useState("");
  const [backfillEnd, setBackfillEnd] = useState("");
  const [backfillStatus, setBackfillStatus] = useState<BackfillStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function reload() {
    const [holdsResponse, statusResponse] = await Promise.all([
      api<{ holds: RetentionHold[] }>(csrfToken, "/api/admin/retention/holds"),
      api<{ storage: StorageStatus }>(csrfToken, "/api/admin/system/status"),
    ]);
    setHolds(holdsResponse.holds);
    setStorage(statusResponse.storage);
  }

  useEffect(() => {
    void reload().catch(() => setError("Failed to load retention data."));
  }, [csrfToken]);

  async function onCreateHold(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setMessage(null);
    try {
      await api(csrfToken, "/api/admin/retention/holds", {
        method: "POST",
        body: JSON.stringify({
          queryVersionId: holdQueryVersionId.trim(),
          reason: holdReason.trim(),
        }),
      });
      setHoldQueryVersionId("");
      setHoldReason("");
      setMessage("Retention hold saved.");
      await reload();
    } catch {
      setError("Could not create retention hold.");
    }
  }

  async function onReleaseHold(queryVersionId: string) {
    setError(null);
    setMessage(null);
    try {
      await api(csrfToken, `/api/admin/retention/holds/${queryVersionId}`, {
        method: "DELETE",
        body: "{}",
      });
      setMessage("Retention hold released.");
      await reload();
    } catch {
      setError("Could not release retention hold.");
    }
  }

  async function onApplyRetention() {
    setError(null);
    setMessage(null);
    try {
      const result = await api<{ outcome: { deletedEvents: number; deletedAggregates: number } }>(
        csrfToken,
        "/api/admin/retention/apply",
        { method: "POST", body: "{}" },
      );
      setMessage(
        `Retention applied: ${result.outcome.deletedEvents} events, ${result.outcome.deletedAggregates} aggregates deleted.`,
      );
    } catch {
      setError("Could not apply retention.");
    }
  }

  async function onManualDelete(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setMessage(null);
    try {
      const result = await api<{ deleted: { deletedEvents: number; deletedAggregates: number } }>(
        csrfToken,
        "/api/admin/retention/manual-delete",
        {
          method: "POST",
          body: JSON.stringify({
            queryVersionId: deleteQueryVersionId.trim(),
            before: deleteBefore.trim() || undefined,
          }),
        },
      );
      setMessage(
        `Manual delete removed ${result.deleted.deletedEvents} events and ${result.deleted.deletedAggregates} aggregates.`,
      );
    } catch {
      setError("Could not run manual delete.");
    }
  }

  async function loadBackfillStatus() {
    if (!backfillQueryVersionId.trim()) {
      return;
    }
    const result = await api<{ status: BackfillStatus }>(
      csrfToken,
      `/api/admin/query-versions/${backfillQueryVersionId.trim()}/backfill/status`,
    );
    setBackfillStatus(result.status);
  }

  async function onCreateBackfill(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setMessage(null);
    try {
      const result = await api<{ status: BackfillStatus }>(
        csrfToken,
        `/api/admin/query-versions/${backfillQueryVersionId.trim()}/backfill`,
        {
          method: "POST",
          body: JSON.stringify({ start: backfillStart, end: backfillEnd }),
        },
      );
      setBackfillStatus(result.status);
      setMessage("Backfill windows created.");
    } catch {
      setError("Could not create backfill.");
    }
  }

  async function onPauseBackfill() {
    setError(null);
    setMessage(null);
    try {
      await api(csrfToken, `/api/admin/query-versions/${backfillQueryVersionId.trim()}/backfill/pause`, {
        method: "POST",
        body: "{}",
      });
      await loadBackfillStatus();
      setMessage("Backfill paused.");
    } catch {
      setError("Could not pause backfill.");
    }
  }

  async function onResumeBackfill() {
    setError(null);
    setMessage(null);
    try {
      await api(csrfToken, `/api/admin/query-versions/${backfillQueryVersionId.trim()}/backfill/resume`, {
        method: "POST",
        body: "{}",
      });
      await loadBackfillStatus();
      setMessage("Backfill resumed.");
    } catch {
      setError("Could not resume backfill.");
    }
  }

  return (
    <div className="stack">
      <header>
        <h1>Retention</h1>
        <p className="muted">Signed in as {user.username}</p>
      </header>

      {error ? <p className="error">{error}</p> : null}
      {message ? <p className="muted">{message}</p> : null}

      {storage ? (
        <section className="panel stack">
          <h2>Storage</h2>
          <p>
            Admission: <strong>{storage.decision}</strong>
          </p>
          <ul>
            {storage.volumes.map((volume) => (
              <li key={volume.path}>
                {volume.path}: {volume.usedPercent.toFixed(1)}% used
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="panel stack">
        <h2>Retention holds</h2>
        <table>
          <thead>
            <tr>
              <th>Query</th>
              <th>Version</th>
              <th>Reason</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {holds.map((hold) => (
              <tr key={hold.id}>
                <td>{hold.queryName}</td>
                <td>{hold.versionNumber}</td>
                <td>{hold.reason}</td>
                <td>
                  <button type="button" onClick={() => void onReleaseHold(hold.queryVersionId)}>
                    Release
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <form className="panel stack" onSubmit={onCreateHold}>
        <h2>Add hold</h2>
        <label>
          Query version ID
          <input
            value={holdQueryVersionId}
            onChange={(event) => setHoldQueryVersionId(event.target.value)}
            required
          />
        </label>
        <label>
          Reason
          <input value={holdReason} onChange={(event) => setHoldReason(event.target.value)} required />
        </label>
        <button type="submit">Save hold</button>
      </form>

      <section className="panel stack">
        <h2>Retention actions</h2>
        <button type="button" onClick={() => void onApplyRetention()}>
          Apply retention now
        </button>
      </section>

      <form className="panel stack" onSubmit={onManualDelete}>
        <h2>Manual delete</h2>
        <label>
          Query version ID
          <input
            value={deleteQueryVersionId}
            onChange={(event) => setDeleteQueryVersionId(event.target.value)}
            required
          />
        </label>
        <label>
          Before (optional ISO timestamp)
          <input value={deleteBefore} onChange={(event) => setDeleteBefore(event.target.value)} />
        </label>
        <button type="submit">Delete archived data</button>
      </form>

      <form className="panel stack" onSubmit={onCreateBackfill}>
        <h2>Backfill</h2>
        <label>
          Query version ID
          <input
            value={backfillQueryVersionId}
            onChange={(event) => setBackfillQueryVersionId(event.target.value)}
            required
          />
        </label>
        <label>
          Start (ISO)
          <input value={backfillStart} onChange={(event) => setBackfillStart(event.target.value)} required />
        </label>
        <label>
          End (ISO)
          <input value={backfillEnd} onChange={(event) => setBackfillEnd(event.target.value)} required />
        </label>
        <div className="row-actions">
          <button type="submit">Create backfill</button>
          <button type="button" onClick={() => void loadBackfillStatus()}>
            Refresh status
          </button>
          <button type="button" onClick={() => void onPauseBackfill()}>
            Pause
          </button>
          <button type="button" onClick={() => void onResumeBackfill()}>
            Resume
          </button>
        </div>
        {backfillStatus ? (
          <p className="muted">
            pending {backfillStatus.pending}, running {backfillStatus.running}, complete{" "}
            {backfillStatus.complete}, paused {backfillStatus.paused}, failed {backfillStatus.failed}
          </p>
        ) : null}
      </form>
    </div>
  );
}
