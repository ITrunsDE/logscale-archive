import { FormEvent, useEffect, useState } from "react";
import { useActionFeedback } from "../client/actionFeedback.js";

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

type StorageStatus = {
  decision: "allow" | "warn" | "block";
  volumes: Array<{ path: string; usedPercent: number }>;
};

type QueryVersionOption = {
  id: string;
  connectionName: string;
  queryName: string;
  versionNumber: number;
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
  const flash = useActionFeedback();
  const [holds, setHolds] = useState<RetentionHold[]>([]);
  const [queryVersions, setQueryVersions] = useState<QueryVersionOption[]>([]);
  const [storage, setStorage] = useState<StorageStatus | null>(null);
  const [holdQueryVersionId, setHoldQueryVersionId] = useState("");
  const [holdReason, setHoldReason] = useState("");
  const [deleteQueryVersionId, setDeleteQueryVersionId] = useState("");
  const [deleteBefore, setDeleteBefore] = useState("");

  async function reload() {
    const [holdsResponse, queryVersionsResponse, statusResponse] = await Promise.all([
      api<{ holds: RetentionHold[] }>(csrfToken, "/api/admin/retention/holds"),
      api<{ queryVersions: QueryVersionOption[] }>(csrfToken, "/api/admin/retention/query-versions"),
      api<{ storage: StorageStatus }>(csrfToken, "/api/admin/system/status"),
    ]);
    setHolds(holdsResponse.holds);
    setQueryVersions(queryVersionsResponse.queryVersions);
    setStorage(statusResponse.storage);
  }

  useEffect(() => {
    void reload().catch(() => flash.err("Failed to load retention data."));
  }, [csrfToken]);

  async function onCreateHold(event: FormEvent) {
    event.preventDefault();
    flash.busy("Saving hold…", "hold");
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
      flash.ok("Retention hold saved.");
      await reload();
    } catch {
      flash.err("Could not create retention hold.");
    }
  }

  async function onReleaseHold(queryVersionId: string) {
    flash.busy("Releasing hold…", `release:${queryVersionId}`);
    try {
      await api(csrfToken, `/api/admin/retention/holds/${queryVersionId}`, {
        method: "DELETE",
        body: "{}",
      });
      flash.ok("Retention hold released.");
      await reload();
    } catch {
      flash.err("Could not release retention hold.");
    }
  }

  async function onApplyRetention() {
    flash.busy("Applying retention…", "apply");
    try {
      const result = await api<{ outcome: { deletedEvents: number; deletedAggregates: number } }>(
        csrfToken,
        "/api/admin/retention/apply",
        { method: "POST", body: "{}" },
      );
      flash.ok(
        `Retention applied: ${result.outcome.deletedEvents} events, ${result.outcome.deletedAggregates} aggregates deleted.`,
      );
    } catch {
      flash.err("Could not apply retention.");
    }
  }

  async function onManualDelete(event: FormEvent) {
    event.preventDefault();
    flash.busy("Deleting archived data…", "delete");
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
      flash.ok(
        `Manual delete removed ${result.deleted.deletedEvents} events and ${result.deleted.deletedAggregates} aggregates.`,
      );
    } catch {
      flash.err("Could not run manual delete.");
    }
  }

  return (
    <div className="stack">
      <header>
        <h1>Retention</h1>
        <p className="muted">Signed in as {user.username}</p>
      </header>

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
                  <button
                    type="button"
                    disabled={flash.anyBusy}
                    aria-busy={flash.isBusy(`release:${hold.queryVersionId}`)}
                    onClick={() => void onReleaseHold(hold.queryVersionId)}
                  >
                    {flash.isBusy(`release:${hold.queryVersionId}`) ? "Releasing…" : "Release"}
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
          Query version
          <select
            value={holdQueryVersionId}
            onChange={(event) => setHoldQueryVersionId(event.target.value)}
            required
          >
            <option value="">Choose query version</option>
            {queryVersions.map((version) => (
              <option key={version.id} value={version.id}>
                {version.connectionName} · {version.queryName} · v{version.versionNumber}
              </option>
            ))}
          </select>
        </label>
        <label>
          Reason
          <input value={holdReason} onChange={(event) => setHoldReason(event.target.value)} required />
        </label>
        <button type="submit" disabled={flash.anyBusy} aria-busy={flash.isBusy("hold")}>
          {flash.isBusy("hold") ? "Saving…" : "Save hold"}
        </button>
      </form>

      <section className="panel stack">
        <h2>Retention actions</h2>
        <button
          type="button"
          disabled={flash.anyBusy}
          aria-busy={flash.isBusy("apply")}
          onClick={() => void onApplyRetention()}
        >
          {flash.isBusy("apply") ? "Applying…" : "Apply retention now"}
        </button>
      </section>

      <form className="panel stack" onSubmit={onManualDelete}>
        <h2>Manual delete</h2>
        <label>
          Query version
          <select
            value={deleteQueryVersionId}
            onChange={(event) => setDeleteQueryVersionId(event.target.value)}
            required
          >
            <option value="">Choose query version</option>
            {queryVersions.map((version) => (
              <option key={version.id} value={version.id}>
                {version.connectionName} · {version.queryName} · v{version.versionNumber}
              </option>
            ))}
          </select>
        </label>
        <label>
          Before (optional ISO timestamp)
          <input value={deleteBefore} onChange={(event) => setDeleteBefore(event.target.value)} />
        </label>
        <button type="submit" disabled={flash.anyBusy} aria-busy={flash.isBusy("delete")}>
          {flash.isBusy("delete") ? "Deleting…" : "Delete archived data"}
        </button>
      </form>
    </div>
  );
}
