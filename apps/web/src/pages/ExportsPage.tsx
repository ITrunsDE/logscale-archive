import { FormEvent, useEffect, useRef, useState } from "react";
import { useActionFeedback } from "../client/actionFeedback.js";
import { formatDateTime, getDisplayTimezone } from "../client/time.js";

type AuthUser = {
  id: string;
  username: string;
  role: "admin" | "viewer";
};

type ExportJob = {
  id: string;
  queryVersionId: string;
  format: "csv" | "ndjson";
  status: "pending" | "running" | "complete" | "failed" | "expired";
  resultCount: number | null;
  errorMessage: string | null;
  expiresAt: string;
  createdAt: string;
  finishedAt: string | null;
};

type QueryVersionOption = {
  id: string;
  name: string;
  versionNumber: number;
  mode: "event" | "aggregate";
  connectionName: string;
  repository: string;
  active: boolean;
};

type ExportFilters = {
  queryVersionId: string;
  format?: "csv" | "ndjson";
  from?: string;
  to?: string;
  jsonFilters: Array<{ field: string; value: string }>;
};

type ExportsPageProps = {
  user: AuthUser;
  csrfToken: string;
  presetFilters?: ExportFilters | null;
  onPresetConsumed?: () => void;
};

const POLL_MS = 2000;

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

function summarizeFilters(filters: ExportFilters, timezone: string): string {
  const parts: string[] = [];
  if (filters.from) {
    parts.push(`from ${formatDateTime(filters.from, timezone)}`);
  }
  if (filters.to) {
    parts.push(`to ${formatDateTime(filters.to, timezone)}`);
  }
  for (const filter of filters.jsonFilters) {
    parts.push(
      filter.field.trim()
        ? `${filter.field}=${filter.value}`
        : `contains ${filter.value}`,
    );
  }
  return parts.length ? parts.join(" · ") : "all rows for this query version";
}

export function ExportsPage({
  user,
  csrfToken,
  presetFilters,
  onPresetConsumed,
}: ExportsPageProps) {
  const timezone = getDisplayTimezone();
  const flash = useActionFeedback();
  const [exports, setExports] = useState<ExportJob[]>([]);
  const [versions, setVersions] = useState<QueryVersionOption[]>([]);
  const [queryVersionId, setQueryVersionId] = useState("");
  const [format, setFormat] = useState<"csv" | "ndjson">("csv");
  // Keep search filters after parent clears the one-shot preset prop.
  const [activeFilters, setActiveFilters] = useState<ExportFilters | null>(null);
  const statusById = useRef(new Map<string, ExportJob["status"]>());
  const autoKeyRef = useRef<string | null>(null);

  async function reload() {
    const response = await api<{ exports: ExportJob[] }>(csrfToken, "/api/exports");
    setExports(response.exports);
  }

  async function requestExport(filters: ExportFilters, exportFormat: "csv" | "ndjson") {
    flash.busy("Requesting export…", "export");
    try {
      await api(csrfToken, "/api/exports", {
        method: "POST",
        body: JSON.stringify({
          queryVersionId: filters.queryVersionId,
          format: exportFormat,
          filters,
        }),
      });
      flash.ok("Export queued — waiting for file…");
      await reload();
    } catch {
      flash.err("Could not request export.");
    }
  }

  useEffect(() => {
    void reload().catch(() => flash.err("Failed to load exports."));
    void api<{ versions: QueryVersionOption[] }>(csrfToken, "/api/results/query-versions")
      .then((response) => {
        setVersions(response.versions);
        setQueryVersionId((current) => current || response.versions[0]?.id || "");
      })
      .catch(() => flash.err("Failed to load query versions."));
  }, [csrfToken]);

  useEffect(() => {
    if (!presetFilters) {
      autoKeyRef.current = null;
      return;
    }
    const key = JSON.stringify(presetFilters);
    if (autoKeyRef.current === key) {
      onPresetConsumed?.();
      return;
    }
    autoKeyRef.current = key;
    const exportFormat = presetFilters.format ?? "csv";
    setQueryVersionId(presetFilters.queryVersionId);
    setFormat(exportFormat);
    setActiveFilters(presetFilters);
    onPresetConsumed?.();
    void requestExport(presetFilters, exportFormat);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetFilters]);

  useEffect(() => {
    const busy = exports.some(
      (job) => job.status === "pending" || job.status === "running",
    );
    if (!busy) {
      return;
    }
    const timer = window.setInterval(() => {
      void reload().catch(() => {});
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [exports, csrfToken]);

  useEffect(() => {
    for (const job of exports) {
      const previous = statusById.current.get(job.id);
      if (
        previous &&
        (previous === "pending" || previous === "running") &&
        job.status === "complete"
      ) {
        flash.ok(
          `Export ready — ${job.resultCount ?? 0} row(s). Download below.`,
        );
      } else if (
        previous &&
        (previous === "pending" || previous === "running") &&
        job.status === "failed"
      ) {
        flash.err(job.errorMessage ?? "Export failed.");
      }
      statusById.current.set(job.id, job.status);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exports]);

  async function onCreateExport(event: FormEvent) {
    event.preventDefault();
    if (!queryVersionId) {
      return;
    }
    const filters: ExportFilters =
      activeFilters?.queryVersionId === queryVersionId
        ? activeFilters
        : { queryVersionId, jsonFilters: [] };
    await requestExport(filters, format);
  }

  async function onDeleteExport(exportId: string) {
    flash.busy("Deleting export…", "export-delete");
    try {
      await api(csrfToken, `/api/exports/${exportId}`, {
        method: "DELETE",
        body: "{}",
      });
      statusById.current.delete(exportId);
      flash.ok("Export deleted.");
      await reload();
    } catch {
      flash.err("Could not delete export.");
    }
  }

  return (
    <div className="stack">
      <header>
        <h1>Exports</h1>
        <p className="muted">Signed in as {user.username}</p>
      </header>

      <form className="panel wide-panel stack" onSubmit={(event) => void onCreateExport(event)}>
        <h2>Request export</h2>
        <label>
          Query version
          <select
            value={queryVersionId}
            onChange={(event) => {
              setQueryVersionId(event.target.value);
              setActiveFilters(null);
            }}
            required
          >
            {versions.map((version) => (
              <option key={version.id} value={version.id}>
                {version.connectionName} / {version.name} v{version.versionNumber} ({version.mode}
                {version.active ? "" : ", inactive"})
              </option>
            ))}
          </select>
        </label>
        <label>
          Format
          <select value={format} onChange={(event) => setFormat(event.target.value as "csv" | "ndjson")}>
            <option value="csv">CSV</option>
            <option value="ndjson">NDJSON</option>
          </select>
        </label>
        {activeFilters ? (
          <p className="muted">Filters: {summarizeFilters(activeFilters, timezone)}</p>
        ) : null}
        <button type="submit" disabled={flash.anyBusy || !queryVersionId} aria-busy={flash.isBusy("export")}>
          {flash.isBusy("export") ? "Requesting…" : "Request export"}
        </button>
      </form>

      <section className="panel wide-panel stack">
        <h2>Export jobs</h2>
        <table>
          <thead>
            <tr>
              <th>Created</th>
              <th>Format</th>
              <th>Status</th>
              <th>Rows</th>
              <th>Expires</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {exports.map((job) => (
              <tr key={job.id}>
                <td>{formatDateTime(job.createdAt, timezone)}</td>
                <td>{job.format}</td>
                <td>{job.status}</td>
                <td>{job.resultCount ?? "—"}</td>
                <td>{formatDateTime(job.expiresAt, timezone)}</td>
                <td className="row-actions-tight">
                  {job.status === "complete" ? (
                    <a href={`/api/exports/${job.id}/download`}>Download</a>
                  ) : job.errorMessage ? (
                    <span className="error">{job.errorMessage}</span>
                  ) : null}
                  {job.status !== "running" ? (
                    <button
                      type="button"
                      className="danger"
                      disabled={flash.anyBusy}
                      onClick={() => void onDeleteExport(job.id)}
                    >
                      Delete
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
