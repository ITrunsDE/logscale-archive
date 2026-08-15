import { FormEvent, useEffect, useState } from "react";
import { useActionFeedback } from "../client/actionFeedback.js";

const DEFAULT_SCHEDULE_CRON = "0 * * * *";
const DEFAULT_SCHEDULE_TIMEZONE = "UTC";

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
  nextRunAt: string | null;
};

type QueryNameSummary = {
  name: string;
  active: boolean;
};

type QueryTestResult = {
  ok: boolean;
  errors: string[];
  eventCount: number;
  sampleEvents: unknown[];
};

type BackfillStatus = {
  pending: number;
  running: number;
  complete: number;
  failed: number;
  paused: number;
};

type QueryEditorPageProps = {
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

function formatTestedAt(value: string | null): string {
  if (!value) {
    return "—";
  }
  return value.slice(11, 16);
}

function formatNextRun(value: string | null): string {
  if (!value) {
    return "—";
  }
  return `${value.slice(0, 16).replace("T", " ")} UTC`;
}

function toLocalInput(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fromLocalInput(local: string): string {
  const date = new Date(local);
  if (Number.isNaN(date.getTime())) {
    return new Date(0).toISOString();
  }
  return date.toISOString();
}

export function QueryEditorPage({ user, csrfToken }: QueryEditorPageProps) {
  const flash = useActionFeedback();
  const [connections, setConnections] = useState<PublicConnection[]>([]);
  const [connectionId, setConnectionId] = useState("");
  const [queryName, setQueryName] = useState("");
  const [queryText, setQueryText] = useState("#repo=");
  const [mode, setMode] = useState<"event" | "aggregate">("event");
  const [scheduleCron, setScheduleCron] = useState(DEFAULT_SCHEDULE_CRON);
  const [scheduleTimezone, setScheduleTimezone] = useState(DEFAULT_SCHEDULE_TIMEZONE);
  const [initialStartAt, setInitialStartAt] = useState("2026-01-01T00:00:00.000Z");
  const [correctionWindowSeconds, setCorrectionWindowSeconds] = useState(300);
  const [retentionDays, setRetentionDays] = useState("");
  const [queryNames, setQueryNames] = useState<QueryNameSummary[]>([]);
  const [versions, setVersions] = useState<QueryVersion[]>([]);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<QueryTestResult | null>(null);
  const [backfillStart, setBackfillStart] = useState("");
  const [backfillEnd, setBackfillEnd] = useState("");
  const [backfillStatus, setBackfillStatus] = useState<BackfillStatus | null>(null);

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

  async function reloadQueryNames() {
    if (!connectionId) {
      setQueryNames([]);
      return;
    }
    const result = await api<{ names: QueryNameSummary[] }>(
      csrfToken,
      `/api/admin/query-versions?connectionId=${encodeURIComponent(connectionId)}`,
    );
    setQueryNames(result.names);
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
    void reloadConnections().catch(() => flash.err("Failed to load connections."));
  }, [csrfToken]);

  useEffect(() => {
    void reloadQueryNames().catch(() => flash.err("Failed to load saved queries."));
  }, [csrfToken, connectionId]);

  useEffect(() => {
    setSelectedVersionId(null);
    setVersions([]);
    setBackfillStatus(null);
    setTestResult(null);
  }, [connectionId]);

  useEffect(() => {
    const name = queryName.trim();
    const selected = name.length > 0 && queryNames.some((entry) => entry.name === name);
    if (!selected) {
      setVersions([]);
      return;
    }
    void reloadVersions().catch(() => flash.err("Failed to load query versions."));
  }, [csrfToken, connectionId, queryName, queryNames]);

  function loadVersion(version: QueryVersion) {
    setSelectedVersionId(version.id);
    setQueryName(version.name);
    setQueryText(version.queryText);
    setMode(version.mode);
    setScheduleCron(version.scheduleCron?.trim() || DEFAULT_SCHEDULE_CRON);
    setScheduleTimezone(version.scheduleTimezone || DEFAULT_SCHEDULE_TIMEZONE);
    setInitialStartAt(version.initialStartAt);
    setCorrectionWindowSeconds(version.correctionWindowSeconds);
    setRetentionDays(version.retentionDays == null ? "" : String(version.retentionDays));
    setTestResult(null);
    setBackfillStatus(null);
    flash.clear();
  }

  function startNewQuery() {
    setSelectedVersionId(null);
    setQueryName("");
    setQueryText("#repo=");
    setMode("event");
    setScheduleCron(DEFAULT_SCHEDULE_CRON);
    setScheduleTimezone(DEFAULT_SCHEDULE_TIMEZONE);
    setInitialStartAt("2026-01-01T00:00:00.000Z");
    setCorrectionWindowSeconds(300);
    setRetentionDays("");
    setVersions([]);
    setTestResult(null);
    setBackfillStatus(null);
    flash.clear();
  }

  async function selectSavedQuery(name: string) {
    setQueryName(name);
    flash.clear();
    if (!connectionId) {
      return;
    }
    try {
      const result = await api<{ versions: QueryVersion[] }>(
        csrfToken,
        `/api/admin/query-versions?connectionId=${encodeURIComponent(connectionId)}&name=${encodeURIComponent(name)}`,
      );
      setVersions(result.versions);
      if (result.versions[0]) {
        loadVersion(result.versions[0]);
      }
    } catch {
      flash.err("Failed to load query versions.");
    }
  }

  async function onSaveDraft(event: FormEvent) {
    event.preventDefault();
    setTestResult(null);
    flash.busy("Saving draft…", "save");
    try {
      const result = await api<{ version: QueryVersion }>(csrfToken, "/api/admin/query-versions/drafts", {
        method: "POST",
        body: JSON.stringify({
          connectionId,
          name: queryName.trim(),
          queryText,
          mode,
          scheduleCron: scheduleCron.trim() || DEFAULT_SCHEDULE_CRON,
          scheduleTimezone: scheduleTimezone.trim() || DEFAULT_SCHEDULE_TIMEZONE,
          initialStartAt,
          correctionWindowSeconds,
          retentionDays: retentionDays.trim() ? Number(retentionDays) : null,
        }),
      });
      setSelectedVersionId(result.version.id);
      flash.ok(`Saved draft v${result.version.versionNumber}.`);
      await Promise.all([reloadVersions(), reloadQueryNames()]);
    } catch (caught) {
      const err = caught as { body?: { validation?: { errors?: string[] } } };
      const validationErrors = err.body?.validation?.errors;
      flash.err(validationErrors?.join(" ") ?? "Could not save draft.");
    }
  }

  async function onTest(versionId: string) {
    flash.busy("Running test…", "test");
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
      if (response.result.ok) {
        flash.ok("Test passed.");
      } else {
        flash.err("Test failed.");
      }
      await reloadVersions();
    } catch {
      flash.err("Could not run test.");
    }
  }

  async function onActivate(versionId: string) {
    flash.busy("Activating…", "activate");
    try {
      await api(csrfToken, `/api/admin/query-versions/${versionId}/activate`, {
        method: "POST",
        body: "{}",
      });
      flash.ok("Version activated.");
      await Promise.all([reloadVersions(), reloadQueryNames()]);
    } catch (caught) {
      const err = caught as { body?: { error?: string } };
      flash.err(
        err.body?.error === "test_required"
          ? "Run a passing test before activation."
          : "Could not activate.",
      );
    }
  }

  async function onDeactivate(versionId: string) {
    flash.busy("Deactivating…", "deactivate");
    try {
      await api(csrfToken, `/api/admin/query-versions/${versionId}/deactivate`, {
        method: "POST",
        body: "{}",
      });
      flash.ok("Version deactivated.");
      await Promise.all([reloadVersions(), reloadQueryNames()]);
    } catch {
      flash.err("Could not deactivate.");
    }
  }

  async function onRenameQuery() {
    const current = queryName.trim();
    if (!connectionId || !current) {
      return;
    }
    const next = window.prompt("Rename query to:", current)?.trim();
    if (!next || next === current) {
      return;
    }
    flash.busy("Renaming…", "rename");
    try {
      await api(csrfToken, "/api/admin/queries/rename", {
        method: "PATCH",
        body: JSON.stringify({
          connectionId,
          oldName: current,
          newName: next,
        }),
      });
      setQueryName(next);
      flash.ok(`Renamed to ${next}.`);
      await Promise.all([reloadQueryNames(), reloadVersions()]);
    } catch (caught) {
      const err = caught as { body?: { error?: string } };
      flash.err(err.body?.error === "name_taken" ? "Name already in use." : "Could not rename.");
    }
  }

  async function onDeleteVersion(version: QueryVersion) {
    if (version.active) {
      flash.err("Deactivate before deleting.");
      return;
    }
    const ok = window.confirm(
      `Delete v${version.versionNumber} of “${version.name}”? Archived runs/events for this version are removed.`,
    );
    if (!ok) {
      return;
    }
    flash.busy("Deleting…", "delete");
    try {
      await api(csrfToken, `/api/admin/query-versions/${version.id}`, {
        method: "DELETE",
        body: "{}",
      });
      if (selectedVersionId === version.id) {
        setSelectedVersionId(null);
        setTestResult(null);
      }
      flash.ok(`Deleted v${version.versionNumber}.`);
      await Promise.all([reloadVersions(), reloadQueryNames()]);
    } catch (caught) {
      const err = caught as { body?: { error?: string } };
      flash.err(
        err.body?.error === "active_version" ? "Deactivate before deleting." : "Could not delete.",
      );
    }
  }

  const selectedVersion = versions.find((version) => version.id === selectedVersionId) ?? null;
  const knownQuery = queryNames.some((entry) => entry.name === queryName.trim());
  const backfillEnabled =
    selectedVersion != null && selectedVersion.mode === "event" && selectedVersion.active;

  async function loadBackfillStatusQuiet(versionId: string) {
    const result = await api<{ status: BackfillStatus }>(
      csrfToken,
      `/api/admin/query-versions/${versionId}/backfill/status`,
    );
    setBackfillStatus(result.status);
  }

  async function loadBackfillStatus() {
    if (!selectedVersionId || !backfillEnabled) {
      return;
    }
    flash.busy("Refreshing backfill…", "bf-status");
    try {
      await loadBackfillStatusQuiet(selectedVersionId);
      flash.ok("Backfill status updated.");
    } catch {
      flash.err("Could not load backfill status.");
    }
  }

  async function onCreateBackfill() {
    if (!selectedVersionId || !backfillEnabled || !backfillStart || !backfillEnd) {
      return;
    }
    flash.busy("Creating backfill…", "backfill");
    try {
      const result = await api<{ status: BackfillStatus; created?: number; requeued?: number }>(
        csrfToken,
        `/api/admin/query-versions/${selectedVersionId}/backfill`,
        {
          method: "POST",
          body: JSON.stringify({
            start: fromLocalInput(backfillStart),
            end: fromLocalInput(backfillEnd),
          }),
        },
      );
      setBackfillStatus(result.status);
      const created = result.created ?? 0;
      const requeued = result.requeued ?? 0;
      flash.ok(
        requeued > 0
          ? `Backfill ready: ${created} new, ${requeued} re-queued (worker will re-run).`
          : `Backfill windows created (${created}).`,
      );
    } catch (error) {
      const code = (error as { body?: { error?: string } })?.body?.error;
      flash.err(
        code === "inactive_query"
          ? "Query inactive — activate before backfill."
          : "Could not create backfill.",
      );
    }
  }

  async function onPauseBackfill() {
    if (!selectedVersionId) {
      return;
    }
    flash.busy("Pausing backfill…", "pause");
    try {
      await api(csrfToken, `/api/admin/query-versions/${selectedVersionId}/backfill/pause`, {
        method: "POST",
        body: "{}",
      });
      await loadBackfillStatusQuiet(selectedVersionId);
      flash.ok("Backfill paused.");
    } catch {
      flash.err("Could not pause backfill.");
    }
  }

  async function onResumeBackfill() {
    if (!selectedVersionId) {
      return;
    }
    flash.busy("Resuming backfill…", "resume");
    try {
      await api(csrfToken, `/api/admin/query-versions/${selectedVersionId}/backfill/resume`, {
        method: "POST",
        body: "{}",
      });
      await loadBackfillStatusQuiet(selectedVersionId);
      flash.ok("Backfill resumed.");
    } catch (error) {
      const code = (error as { body?: { error?: string } })?.body?.error;
      flash.err(
        code === "inactive_query"
          ? "Query inactive — activate before resume."
          : "Could not resume backfill.",
      );
    }
  }

  useEffect(() => {
    if (!selectedVersionId || !backfillEnabled) {
      setBackfillStatus(null);
      return;
    }
    void loadBackfillStatusQuiet(selectedVersionId).catch(() => {
      setBackfillStatus(null);
    });
  }, [csrfToken, selectedVersionId, backfillEnabled]);

  return (
    <div className="stack">
      <header>
        <h1>Query editor</h1>
        <p className="muted">Signed in as {user.username}</p>
      </header>

      <div className="query-editor-layout">
        <aside className="panel stack query-editor-nav">
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

          <div className="stack">
            <div className="query-nav-head">
              <h2>Queries</h2>
              <button type="button" className="secondary" onClick={startNewQuery} disabled={flash.anyBusy}>
                New
              </button>
            </div>
            {queryNames.length === 0 ? (
              <p className="muted">No saved queries yet.</p>
            ) : (
              <ul className="query-nav-list">
                {queryNames.map((entry) => {
                  const selected = entry.name === queryName.trim();
                  return (
                    <li key={entry.name}>
                      <button
                        type="button"
                        className={`query-nav-btn${selected ? " version-chip-selected" : ""}`}
                        aria-pressed={selected}
                        aria-label={entry.active ? `${entry.name} (active)` : entry.name}
                        onClick={() => void selectSavedQuery(entry.name)}
                      >
                        <span className={`query-active-dot${entry.active ? "" : " off"}`} aria-hidden="true" />
                        <span className="mono">{entry.name}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            {knownQuery ? (
              <div className="row-actions-tight">
                <button type="button" className="secondary" disabled={flash.anyBusy} onClick={() => void onRenameQuery()}>
                  {flash.isBusy("rename") ? "Renaming…" : "Rename"}
                </button>
              </div>
            ) : null}
          </div>

          {knownQuery ? (
            <div className="stack">
              <h2>Versions</h2>
              {versions.length === 0 ? (
                <p className="muted">No versions for this query.</p>
              ) : (
                <ul className="version-nav-list">
                  {versions.map((version) => {
                    const selected = version.id === selectedVersionId;
                    return (
                      <li key={version.id} className={`version-block${selected ? " selected" : ""}`}>
                        <button
                          type="button"
                          className={`version-row${selected ? " version-chip-selected" : ""}`}
                          aria-pressed={selected}
                          onClick={() => loadVersion(version)}
                        >
                          <span className="mono">
                            v{version.versionNumber} · {version.active ? "active" : "inactive"}
                          </span>
                          <span className="version-meta">
                            <span>tested {formatTestedAt(version.testPassedAt)}</span>
                            <span>next {formatNextRun(version.nextRunAt)}</span>
                          </span>
                        </button>
                        {selected ? (
                          <div className="version-actions">
                            <button
                              type="button"
                              className="secondary"
                              disabled={flash.anyBusy}
                              aria-busy={flash.isBusy("test")}
                              onClick={() => void onTest(version.id)}
                            >
                              {flash.isBusy("test") ? "…" : "Test"}
                            </button>
                            {version.active ? (
                              <button
                                type="button"
                                className="secondary"
                                disabled={flash.anyBusy}
                                aria-busy={flash.isBusy("deactivate")}
                                onClick={() => void onDeactivate(version.id)}
                              >
                                {flash.isBusy("deactivate") ? "…" : "Deactivate"}
                              </button>
                            ) : (
                              <button
                                type="button"
                                className="secondary"
                                disabled={flash.anyBusy}
                                aria-busy={flash.isBusy("activate")}
                                onClick={() => void onActivate(version.id)}
                              >
                                {flash.isBusy("activate") ? "…" : "Activate"}
                              </button>
                            )}
                            <button
                              type="button"
                              className="danger"
                              disabled={flash.anyBusy || version.active}
                              aria-busy={flash.isBusy("delete")}
                              onClick={() => void onDeleteVersion(version)}
                            >
                              {flash.isBusy("delete") ? "…" : "Delete"}
                            </button>
                          </div>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          ) : (
            <p className="muted nav-hint">Select a query to see versions.</p>
          )}
        </aside>

        <form className="panel stack query-editor-main" onSubmit={onSaveDraft}>
          <div className="editor-head">
            <h2>
              Draft {queryName.trim() ? <span className="mono">{queryName.trim()}</span> : null}
            </h2>
            {selectedVersion ? (
              <span className="editor-badge">editing v{selectedVersion.versionNumber}</span>
            ) : (
              <span className="editor-badge">new draft</span>
            )}
          </div>

          <label>
            Query name
            {knownQuery ? (
              <>
                <input value={queryName} readOnly aria-readonly="true" />
                <span className="field-hint">Saved name — use Rename or New.</span>
              </>
            ) : (
              <>
                <input
                  value={queryName}
                  onChange={(event) => setQueryName(event.target.value)}
                  required
                  placeholder="Name for new query"
                />
                <span className="field-hint">Set once here; rename later via Rename.</span>
              </>
            )}
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

          <details className="schedule-details">
            <summary>Schedule &amp; retention</summary>
            <div className="schedule-grid">
              <label>
                Schedule cron
                <input
                  value={scheduleCron}
                  onChange={(event) => setScheduleCron(event.target.value)}
                  placeholder={DEFAULT_SCHEDULE_CRON}
                />
                <span className="field-hint">Default: hourly UTC (`{DEFAULT_SCHEDULE_CRON}`)</span>
              </label>
              <label>
                Schedule timezone
                <input
                  value={scheduleTimezone}
                  onChange={(event) => setScheduleTimezone(event.target.value)}
                  placeholder={DEFAULT_SCHEDULE_TIMEZONE}
                />
              </label>
              <label>
                Initial start
                <input
                  type="datetime-local"
                  value={toLocalInput(initialStartAt)}
                  onChange={(event) => setInitialStartAt(fromLocalInput(event.target.value))}
                />
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
            </div>
          </details>

          {selectedVersion ? (
            <details className="schedule-details">
              <summary>Fill history (backfill)</summary>
              <p className="muted field-hint">
                For active event versions. Pick start/end — archive fills missing UTC days from
                LogScale for v{selectedVersion.versionNumber}. Create again on the same range
                re-queues completed days (needed after caps/truncation).
              </p>
              {!backfillEnabled ? (
                <p className="muted">
                  {selectedVersion.mode !== "event"
                    ? "Only event queries support backfill."
                    : "Activate this version to create or resume a backfill."}
                </p>
              ) : null}
              <div className="schedule-grid">
                <label>
                  Start
                  <input
                    type="datetime-local"
                    value={backfillStart}
                    onChange={(event) => setBackfillStart(event.target.value)}
                    disabled={!backfillEnabled || flash.anyBusy}
                  />
                </label>
                <label>
                  End
                  <input
                    type="datetime-local"
                    value={backfillEnd}
                    onChange={(event) => setBackfillEnd(event.target.value)}
                    disabled={!backfillEnabled || flash.anyBusy}
                  />
                </label>
              </div>
              <div className="row-actions">
                <button
                  type="button"
                  disabled={!backfillEnabled || flash.anyBusy || !backfillStart || !backfillEnd}
                  aria-busy={flash.isBusy("backfill")}
                  onClick={() => void onCreateBackfill()}
                >
                  {flash.isBusy("backfill") ? "Creating…" : "Create / re-run"}
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={!backfillEnabled || flash.anyBusy}
                  aria-busy={flash.isBusy("bf-status")}
                  onClick={() => void loadBackfillStatus()}
                >
                  {flash.isBusy("bf-status") ? "…" : "Status"}
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={!backfillEnabled || flash.anyBusy}
                  aria-busy={flash.isBusy("pause")}
                  onClick={() => void onPauseBackfill()}
                >
                  {flash.isBusy("pause") ? "…" : "Pause"}
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={!backfillEnabled || flash.anyBusy}
                  aria-busy={flash.isBusy("resume")}
                  onClick={() => void onResumeBackfill()}
                >
                  {flash.isBusy("resume") ? "…" : "Resume"}
                </button>
              </div>
              {backfillStatus ? (
                <p className="muted field-hint tabular-meta">
                  pending {backfillStatus.pending} · running {backfillStatus.running} · complete{" "}
                  {backfillStatus.complete} · paused {backfillStatus.paused} · failed{" "}
                  {backfillStatus.failed}
                </p>
              ) : null}
            </details>
          ) : null}

          <div className="footer-actions">
            <button type="submit" className="primary" disabled={flash.anyBusy} aria-busy={flash.isBusy("save")}>
              {flash.isBusy("save") ? "Saving…" : "Save draft"}
            </button>
          </div>

          {testResult ? (
            <section className="stack">
              <h2>Sample results</h2>
              <p className="muted">
                {testResult.ok ? "Validation passed" : "Validation failed"} · {testResult.eventCount}{" "}
                event(s)
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
        </form>
      </div>
    </div>
  );
}
