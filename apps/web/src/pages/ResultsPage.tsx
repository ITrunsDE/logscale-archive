import { FormEvent, useEffect, useState } from "react";

type AuthUser = {
  id: string;
  username: string;
  role: "admin" | "viewer";
};

type QueryVersionOption = {
  id: string;
  name: string;
  versionNumber: number;
  mode: "event" | "aggregate";
  connectionName: string;
  repository: string;
};

type StoredResultRow = {
  id: string;
  queryRunId: string;
  timestamp: string;
  metadata: Record<string, unknown>;
  payload: Record<string, unknown>;
  runStatus: string | null;
};

type SearchResponse = {
  results: {
    mode: "event" | "aggregate";
    columns: string[];
    rows: StoredResultRow[];
    total: number;
    limit: number;
    offset: number;
  };
};

type ResultsPageProps = {
  user: AuthUser;
  csrfToken: string;
  onRequestExport?: (filters: {
    queryVersionId: string;
    from?: string;
    to?: string;
    jsonFilters: Array<{ field: string; value: string }>;
  }) => void;
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

function cellValue(row: StoredResultRow, column: string): string {
  const record = { ...row.metadata, ...row.payload } as Record<string, unknown>;
  const value = record[column];
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

function stampClass(status: string | null): string {
  if (!status) {
    return "stamp";
  }
  const normalized = status.toLowerCase();
  if (normalized === "complete" || normalized === "completed") {
    return "stamp stamp-complete";
  }
  if (normalized === "failed" || normalized === "fail") {
    return "stamp stamp-failed";
  }
  if (normalized === "split") {
    return "stamp stamp-split";
  }
  if (normalized === "held" || normalized === "hold") {
    return "stamp stamp-held";
  }
  if (normalized === "cap") {
    return "stamp stamp-cap";
  }
  return "stamp";
}

export function ResultsPage({ user, csrfToken, onRequestExport }: ResultsPageProps) {
  const [versions, setVersions] = useState<QueryVersionOption[]>([]);
  const [queryVersionId, setQueryVersionId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [jsonField, setJsonField] = useState("");
  const [jsonValue, setJsonValue] = useState("");
  const [results, setResults] = useState<SearchResponse["results"] | null>(null);
  const [selected, setSelected] = useState<StoredResultRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    void api<{ versions: QueryVersionOption[] }>(csrfToken, "/api/results/query-versions")
      .then((response) => {
        setVersions(response.versions);
        if (response.versions[0]) {
          setQueryVersionId(response.versions[0].id);
        }
      })
      .catch(() => setError("Failed to load query versions."));
  }, [csrfToken]);

  useEffect(() => {
    if (!selected) {
      return;
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setSelected(null);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selected]);

  async function runSearch(event?: FormEvent, offset = 0) {
    event?.preventDefault();
    if (!queryVersionId) {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const jsonFilters = jsonField.trim()
        ? [{ field: jsonField.trim(), value: jsonValue }]
        : [];
      const response = await api<SearchResponse>(csrfToken, "/api/results/search", {
        method: "POST",
        body: JSON.stringify({
          queryVersionId,
          from: from || undefined,
          to: to || undefined,
          jsonFilters,
          offset,
        }),
      });
      setResults(response.results);
      setSelected(null);
    } catch {
      setError("Search failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="results-layout">
      <div className="results-main stack">
        <header>
          <h1>Results</h1>
          <p className="muted">Signed in as {user.username}. Archived data only.</p>
        </header>

        {error ? <p className="error">{error}</p> : null}

        <form className="panel wide-panel stack" onSubmit={(event) => void runSearch(event)}>
          <h2>Search archived results</h2>
          <label>
            Query version
            <select
              value={queryVersionId}
              onChange={(event) => setQueryVersionId(event.target.value)}
              required
            >
              {versions.map((version) => (
                <option key={version.id} value={version.id}>
                  {version.connectionName} / {version.name} v{version.versionNumber} ({version.mode})
                </option>
              ))}
            </select>
          </label>
          <label>
            From (ISO timestamp)
            <input value={from} onChange={(event) => setFrom(event.target.value)} />
          </label>
          <label>
            To (ISO timestamp)
            <input value={to} onChange={(event) => setTo(event.target.value)} />
          </label>
          <label>
            JSON field
            <input value={jsonField} onChange={(event) => setJsonField(event.target.value)} />
          </label>
          <label>
            JSON value
            <input value={jsonValue} onChange={(event) => setJsonValue(event.target.value)} />
          </label>
          <div className="row-actions">
            <button type="submit" disabled={loading}>
              {loading ? "Searching…" : "Search"}
            </button>
            {onRequestExport ? (
              <button
                type="button"
                onClick={() =>
                  onRequestExport({
                    queryVersionId,
                    from: from || undefined,
                    to: to || undefined,
                    jsonFilters: jsonField.trim()
                      ? [{ field: jsonField.trim(), value: jsonValue }]
                      : [],
                  })
                }
              >
                Export current filters
              </button>
            ) : null}
          </div>
        </form>

        {results ? (
          <section className="panel wide-panel stack">
            <p className="muted">
              {results.total} result{results.total === 1 ? "" : "s"} ({results.mode})
            </p>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    {results.columns.map((column) => (
                      <th key={column}>{column}</th>
                    ))}
                    <th>run</th>
                  </tr>
                </thead>
                <tbody>
                  {results.rows.map((row) => (
                    <tr
                      key={row.id}
                      className={selected?.id === row.id ? "row-selected" : undefined}
                      onClick={() => setSelected(row)}
                    >
                      {results.columns.map((column) => (
                        <td key={column}>{cellValue(row, column)}</td>
                      ))}
                      <td>
                        {row.runStatus ? (
                          <span className={stampClass(row.runStatus)}>{row.runStatus}</span>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="row-actions">
              <button
                type="button"
                disabled={results.offset <= 0}
                onClick={() => void runSearch(undefined, Math.max(0, results.offset - results.limit))}
              >
                Previous
              </button>
              <button
                type="button"
                disabled={results.offset + results.limit >= results.total}
                onClick={() => void runSearch(undefined, results.offset + results.limit)}
              >
                Next
              </button>
            </div>
          </section>
        ) : null}
      </div>

      {selected ? (
        <aside className="drawer stack">
          <header>
            <h2>Record JSON</h2>
            {selected.runStatus ? (
              <p className={stampClass(selected.runStatus)}>{selected.runStatus}</p>
            ) : null}
          </header>
          <pre className="mono drawer-json">
            {JSON.stringify({ ...selected.metadata, ...selected.payload }, null, 2)}
          </pre>
          <button type="button" onClick={() => setSelected(null)}>
            Close
          </button>
        </aside>
      ) : null}
    </div>
  );
}
