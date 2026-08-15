import { FormEvent, useEffect, useState } from "react";

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

type ExportFilters = {
  queryVersionId: string;
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

export function ExportsPage({
  user,
  csrfToken,
  presetFilters,
  onPresetConsumed,
}: ExportsPageProps) {
  const [exports, setExports] = useState<ExportJob[]>([]);
  const [queryVersionId, setQueryVersionId] = useState("");
  const [format, setFormat] = useState<"csv" | "ndjson">("csv");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function reload() {
    const response = await api<{ exports: ExportJob[] }>(csrfToken, "/api/exports");
    setExports(response.exports);
  }

  useEffect(() => {
    void reload().catch(() => setError("Failed to load exports."));
  }, [csrfToken]);

  useEffect(() => {
    if (presetFilters) {
      setQueryVersionId(presetFilters.queryVersionId);
      onPresetConsumed?.();
    }
  }, [presetFilters, onPresetConsumed]);

  async function onCreateExport(event: FormEvent) {
    event.preventDefault();
    if (!queryVersionId) {
      return;
    }
    setError(null);
    setMessage(null);
    try {
      await api(csrfToken, "/api/exports", {
        method: "POST",
        body: JSON.stringify({
          queryVersionId,
          format,
          filters: presetFilters ?? { queryVersionId },
        }),
      });
      setMessage("Export requested.");
      await reload();
    } catch {
      setError("Could not request export.");
    }
  }

  return (
    <div className="stack">
      <header>
        <h1>Exports</h1>
        <p className="muted">Signed in as {user.username}</p>
      </header>

      {error ? <p className="error">{error}</p> : null}
      {message ? <p className="muted">{message}</p> : null}

      <form className="panel wide-panel stack" onSubmit={(event) => void onCreateExport(event)}>
        <h2>Request export</h2>
        <label>
          Query version ID
          <input
            value={queryVersionId}
            onChange={(event) => setQueryVersionId(event.target.value)}
            required
          />
        </label>
        <label>
          Format
          <select value={format} onChange={(event) => setFormat(event.target.value as "csv" | "ndjson")}>
            <option value="csv">CSV</option>
            <option value="ndjson">NDJSON</option>
          </select>
        </label>
        <button type="submit">Request export</button>
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
                <td>{new Date(job.createdAt).toLocaleString()}</td>
                <td>{job.format}</td>
                <td>{job.status}</td>
                <td>{job.resultCount ?? "—"}</td>
                <td>{new Date(job.expiresAt).toLocaleString()}</td>
                <td>
                  {job.status === "complete" ? (
                    <a href={`/api/exports/${job.id}/download`}>Download</a>
                  ) : job.errorMessage ? (
                    <span className="error">{job.errorMessage}</span>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
