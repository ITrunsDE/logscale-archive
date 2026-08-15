import { FormEvent, useEffect, useState } from "react";

type AuthUser = {
  id: string;
  username: string;
  role: "admin" | "viewer";
};

type PublicConnection = {
  id: string;
  name: string;
  endpoint: string;
  repository: string;
  status: string;
};

type QueryVersion = {
  id: string;
  connectionId: string;
  name: string;
  versionNumber: number;
  queryText: string;
  mode: "event" | "aggregate";
  scheduleCron: string | null;
  scheduleTimezone: string;
  initialStartAt: string;
  correctionWindowSeconds: number;
  retentionDays: number | null;
  active: boolean;
  testPassedAt: string | null;
  createdAt: string;
};

type QueryTestResult = {
  ok: boolean;
  errors: string[];
  eventCount: number;
  sampleEvents: unknown[];
};

type QueryEditorPageProps = {
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

export function QueryEditorPage({ user, csrfToken }: QueryEditorPageProps) {
  const [connections, setConnections] = useState<PublicConnection[]>([]);
  const [connectionId, setConnectionId] = useState("");
  const [queryName, setQueryName] = useState("events");
  const [queryText, setQueryText] = useState("#repo=");
  const [mode, setMode] = useState<"event" | "aggregate">("event");
  const [scheduleCron, setScheduleCron] = useState("0 * * * *");
  const [scheduleTimezone, setScheduleTimezone] = useState("UTC");
  const [initialStartAt, setInitialStartAt] = useState("2026-01-01T00:00:00.000Z");
  const [correctionWindowSeconds, setCorrectionWindowSeconds] = useState(300);
  const [retentionDays, setRetentionDays] = useState("");
  const [versions, setVersions] = useState<QueryVersion[]>([]);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<QueryTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function reloadConnections() {
    const result = await api<{ connections: PublicConnection[] }>(
      csrfToken,
      "/api/admin/logscale-connections",
    );
    setConnections(result.connections);
    if (!connectionId && result.connections[0]) {
      setConnectionId(result.connections[0].id);
    }
  }

  async function reloadVersions() {
    if (!connectionId || !queryName.trim()) {
      setVersions([]);
      return;
    }
    const result = await api<{ versions: QueryVersion[] }>(
      csrfToken,
      `/api/admin/query-versions?connectionId=${encodeURIComponent(connectionId)}&name=${encodeURIComponent(queryName.trim())}`,
    );
    setVersions(result.versions);
  }

  useEffect(() => {
    void reloadConnections().catch(() => setError("Failed to load connections."));
  }, [csrfToken]);

  useEffect(() => {
    void reloadVersions().catch(() => setError("Failed to load query versions."));
  }, [csrfToken, connectionId, queryName]);

  function loadVersion(version: QueryVersion) {
    setSelectedVersionId(version.id);
    setQueryText(version.queryText);
    setMode(version.mode);
    setScheduleCron(version.scheduleCron ?? "");
    setScheduleTimezone(version.scheduleTimezone);
    setInitialStartAt(version.initialStartAt);
    setCorrectionWindowSeconds(version.correctionWindowSeconds);
    setRetentionDays(version.retentionDays == null ? "" : String(version.retentionDays));
    setTestResult(null);
    setError(null);
    setMessage(null);
  }

  async function onSaveDraft(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setMessage(null);
    setTestResult(null);
    try {
      const result = await api<{ version: QueryVersion }>(csrfToken, "/api/admin/query-versions/drafts", {
        method: "POST",
        body: JSON.stringify({
          connectionId,
          name: queryName.trim(),
          queryText,
          mode,
          scheduleCron: scheduleCron.trim() || null,
          scheduleTimezone,
          initialStartAt,
          correctionWindowSeconds,
          retentionDays: retentionDays.trim() ? Number(retentionDays) : null,
        }),
      });
      setSelectedVersionId(result.version.id);
      setMessage(`Saved draft v${result.version.versionNumber}.`);
      await reloadVersions();
    } catch (caught) {
      const err = caught as { body?: { validation?: { errors?: string[] } } };
      const validationErrors = err.body?.validation?.errors;
      setError(validationErrors?.join(" ") ?? "Could not save draft.");
    }
  }

  async function onTest(versionId: string) {
    setError(null);
    setMessage(null);
    try {
      const end = new Date();
      const start = new Date(end.getTime() - 60 * 60 * 1000);
      const response = await api<{ result: QueryTestResult }>(
        csrfToken,
        `/api/admin/query-versions/${versionId}/test`,
        {
          method: "POST",
          body: JSON.stringify({
            start: start.toISOString(),
            end: end.toISOString(),
          }),
        },
      );
      setTestResult(response.result);
      setMessage(response.result.ok ? "Test passed." : "Test failed.");
      await reloadVersions();
    } catch {
      setError("Could not run test.");
    }
  }

  async function onActivate(versionId: string) {
    setError(null);
    setMessage(null);
    try {
      await api(csrfToken, `/api/admin/query-versions/${versionId}/activate`, {
        method: "POST",
        body: "{}",
      });
      setMessage("Version activated.");
      await reloadVersions();
    } catch (caught) {
      const err = caught as { body?: { error?: string } };
      setError(err.body?.error === "test_required" ? "Run a passing test before activation." : "Could not activate.");
    }
  }

  async function onDeactivate(versionId: string) {
    setError(null);
    setMessage(null);
    try {
      await api(csrfToken, `/api/admin/query-versions/${versionId}/deactivate`, {
        method: "POST",
        body: "{}",
      });
      setMessage("Version deactivated.");
      await reloadVersions();
    } catch {
      setError("Could not deactivate.");
    }
  }

  const selectedVersion = versions.find((version) => version.id === selectedVersionId) ?? null;

  return (
    <div className="stack">
      <header>
        <h1>Query editor</h1>
        <p className="muted">Signed in as {user.username}</p>
      </header>

      {error ? <p className="error">{error}</p> : null}
      {message ? <p className="muted">{message}</p> : null}

      <section className="panel stack wide-panel">
        <h2>Version history</h2>
        {versions.length === 0 ? (
          <p className="muted">No versions yet.</p>
        ) : (
          <ul className="version-list">
            {versions.map((version) => (
              <li key={version.id}>
                <button type="button" className="version-chip" onClick={() => loadVersion(version)}>
                  <span className="mono">
                    v{version.versionNumber} · {version.active ? "active" : "inactive"}
                  </span>
                </button>
                {version.testPassedAt ? (
                  <span className="muted"> tested {version.testPassedAt}</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <form className="panel stack wide-panel" onSubmit={onSaveDraft}>
        <h2>Draft configuration</h2>
        <label>
          Connection
          <select value={connectionId} onChange={(event) => setConnectionId(event.target.value)} required>
            <option value="" disabled>
              Select connection
            </option>
            {connections.map((connection) => (
              <option key={connection.id} value={connection.id}>
                {connection.name} ({connection.repository})
              </option>
            ))}
          </select>
        </label>
        <label>
          Query name
          <input value={queryName} onChange={(event) => setQueryName(event.target.value)} required />
        </label>
        <label>
          Mode
          <div className="segmented" role="group" aria-label="Query mode">
            <button
              type="button"
              className={mode === "event" ? "segmented-active" : ""}
              onClick={() => setMode("event")}
            >
              Event
            </button>
            <button
              type="button"
              className={mode === "aggregate" ? "segmented-active" : ""}
              onClick={() => setMode("aggregate")}
            >
              Aggregate
            </button>
          </div>
        </label>
        <label>
          Query text
          <textarea
            className="query-text"
            value={queryText}
            onChange={(event) => setQueryText(event.target.value)}
            rows={8}
            required
          />
        </label>
        <label>
          Schedule cron
          <input value={scheduleCron} onChange={(event) => setScheduleCron(event.target.value)} />
        </label>
        <label>
          Schedule timezone
          <input value={scheduleTimezone} onChange={(event) => setScheduleTimezone(event.target.value)} />
        </label>
        <label>
          Initial start (UTC)
          <input value={initialStartAt} onChange={(event) => setInitialStartAt(event.target.value)} required />
        </label>
        <label>
          Correction window (seconds)
          <input
            type="number"
            min={0}
            value={correctionWindowSeconds}
            onChange={(event) => setCorrectionWindowSeconds(Number(event.target.value))}
          />
        </label>
        <label>
          Retention days
          <input value={retentionDays} onChange={(event) => setRetentionDays(event.target.value)} />
        </label>
        <button type="submit">Save draft</button>
      </form>

      {selectedVersion ? (
        <section className="panel stack wide-panel">
          <h2>
            Selected <span className="mono">v{selectedVersion.versionNumber}</span>
          </h2>
          <div className="row-actions">
            <button type="button" onClick={() => void onTest(selectedVersion.id)}>
              Run test
            </button>
            <button type="button" onClick={() => void onActivate(selectedVersion.id)}>
              Activate
            </button>
            <button type="button" onClick={() => void onDeactivate(selectedVersion.id)}>
              Deactivate
            </button>
          </div>
        </section>
      ) : null}

      {testResult ? (
        <section className="panel stack wide-panel">
          <h2>Sample results</h2>
          <p className="muted">
            {testResult.ok ? "Validation passed" : "Validation failed"} · {testResult.eventCount} event(s)
          </p>
          {testResult.errors.length > 0 ? (
            <ul>
              {testResult.errors.map((item) => (
                <li key={item} className="error">
                  {item}
                </li>
              ))}
            </ul>
          ) : null}
          <pre className="sample-results">{JSON.stringify(testResult.sampleEvents, null, 2)}</pre>
        </section>
      ) : null}
    </div>
  );
}
