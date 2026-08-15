import { FormEvent, useEffect, useState } from "react";
import { useActionFeedback } from "../client/actionFeedback.js";

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
  lastValidatedAt: string | null;
  tokenExpiryWarning: string | null;
};

type ConnectionValidation = {
  ok: boolean;
  serverVersion?: string;
  repositoryAccessible: boolean;
  permissionWarnings: string[];
  error?: string;
};

type ConnectionsPageProps = {
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

export function ConnectionsPage({ user, csrfToken }: ConnectionsPageProps) {
  const flash = useActionFeedback();
  const [connections, setConnections] = useState<PublicConnection[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [repository, setRepository] = useState("");
  const [token, setToken] = useState("");
  const [validation, setValidation] = useState<ConnectionValidation | null>(null);
  const [rowBusyId, setRowBusyId] = useState<string | null>(null);

  async function reload() {
    const result = await api<{ connections: PublicConnection[] }>(
      csrfToken,
      "/api/admin/logscale-connections",
    );
    setConnections(result.connections);
  }

  useEffect(() => {
    void reload().catch(() => flash.err("Failed to load connections."));
  }, [csrfToken]);

  function resetForm() {
    setEditingId(null);
    setName("");
    setEndpoint("");
    setRepository("");
    setToken("");
  }

  function startEdit(connection: PublicConnection) {
    setEditingId(connection.id);
    setName(connection.name);
    setEndpoint(connection.endpoint);
    setRepository(connection.repository);
    setToken("");
    setValidation(null);
    flash.clear();
  }

  function applySaveResult(
    result: { connection: PublicConnection; validation: ConnectionValidation },
    savedLabel: string,
  ) {
    setValidation(result.validation);
    flash.ok(`${savedLabel} Status: ${result.connection.status}.`);
    resetForm();
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setValidation(null);
    flash.busy(editingId ? "Updating connection…" : "Saving connection…", "save");
    try {
      if (editingId) {
        const payload: Record<string, string> = { name, endpoint, repository };
        if (token.trim()) {
          payload.token = token.trim();
        }
        const result = await api<{ connection: PublicConnection; validation: ConnectionValidation }>(
          csrfToken,
          `/api/admin/logscale-connections/${editingId}`,
          { method: "PATCH", body: JSON.stringify(payload) },
        );
        applySaveResult(result, "Connection updated.");
      } else {
        const result = await api<{ connection: PublicConnection; validation: ConnectionValidation }>(
          csrfToken,
          "/api/admin/logscale-connections",
          {
            method: "POST",
            body: JSON.stringify({ name, endpoint, repository, token }),
          },
        );
        applySaveResult(result, "Connection saved.");
      }
      await reload();
    } catch {
      flash.err(editingId ? "Could not update connection." : "Could not save connection.");
    }
  }

  async function onValidate(connectionId: string) {
    setValidation(null);
    setRowBusyId(connectionId);
    flash.busy("Validating…", `validate:${connectionId}`);
    try {
      const result = await api<{ connection: PublicConnection; validation: ConnectionValidation }>(
        csrfToken,
        `/api/admin/logscale-connections/${connectionId}/validate`,
        { method: "POST", body: "{}" },
      );
      setValidation(result.validation);
      flash.ok(`Validation finished with status ${result.connection.status}.`);
      await reload();
    } catch {
      flash.err("Could not validate connection.");
    } finally {
      setRowBusyId(null);
    }
  }

  async function onDelete(connectionId: string) {
    setValidation(null);
    setRowBusyId(connectionId);
    flash.busy("Deleting…", `delete:${connectionId}`);
    try {
      await api(csrfToken, `/api/admin/logscale-connections/${connectionId}`, {
        method: "DELETE",
        body: "{}",
      });
      if (editingId === connectionId) {
        resetForm();
      }
      flash.ok("Connection deleted.");
      await reload();
    } catch {
      flash.err("Could not delete connection.");
    } finally {
      setRowBusyId(null);
    }
  }

  return (
    <div className="stack">
      <header>
        <h1>LogScale connections</h1>
        <p className="muted">Signed in as {user.username}</p>
      </header>

      <section className="panel stack">
        <h2>Saved connections</h2>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Endpoint</th>
              <th>Repository</th>
              <th>Status</th>
              <th>Last validated</th>
              <th>Expiry</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {connections.map((connection) => (
              <tr key={connection.id}>
                <td>{connection.name}</td>
                <td>{connection.endpoint}</td>
                <td>{connection.repository}</td>
                <td>{connection.status}</td>
                <td>{connection.lastValidatedAt ?? "—"}</td>
                <td>{connection.tokenExpiryWarning ?? "—"}</td>
                <td>
                  <button type="button" onClick={() => startEdit(connection)} disabled={flash.anyBusy}>
                    Edit
                  </button>{" "}
                  <button
                    type="button"
                    disabled={flash.anyBusy}
                    aria-busy={flash.isBusy(`validate:${connection.id}`)}
                    onClick={() => void onValidate(connection.id)}
                  >
                    {rowBusyId === connection.id && flash.isBusy(`validate:${connection.id}`)
                      ? "Validating…"
                      : "Validate"}
                  </button>{" "}
                  <button
                    type="button"
                    disabled={flash.anyBusy}
                    aria-busy={flash.isBusy(`delete:${connection.id}`)}
                    onClick={() => void onDelete(connection.id)}
                  >
                    {rowBusyId === connection.id && flash.isBusy(`delete:${connection.id}`)
                      ? "Deleting…"
                      : "Delete"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {validation ? (
        <section className="panel stack">
          <h2>Validation result</h2>
          <p>Server version: {validation.serverVersion ?? "unknown"}</p>
          <p>Repository accessible: {validation.repositoryAccessible ? "yes" : "no"}</p>
          {validation.permissionWarnings.length > 0 ? (
            <ul>
              {validation.permissionWarnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          ) : (
            <p className="muted">No permission warnings.</p>
          )}
          {validation.error ? <p className="error">{validation.error}</p> : null}
        </section>
      ) : null}

      <form className="panel stack" onSubmit={onSubmit}>
        <h2>{editingId ? "Edit connection" : "Add connection"}</h2>
        <p className="muted">
          Tokens are encrypted at rest. Only name, endpoint, repository, and status are shown after
          save. Create and update run validation immediately.
        </p>
        <label>
          Name
          <input value={name} onChange={(event) => setName(event.target.value)} required />
        </label>
        <label>
          Endpoint
          <input
            value={endpoint}
            onChange={(event) => setEndpoint(event.target.value)}
            placeholder="https://cloud.community.humio.com"
            required
          />
        </label>
        <label>
          Repository
          <input value={repository} onChange={(event) => setRepository(event.target.value)} required />
        </label>
        <label>
          Token
          <input
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            autoComplete="off"
            required={!editingId}
            placeholder={editingId ? "Leave blank to keep existing token" : undefined}
          />
        </label>
        <div>
          <button type="submit" disabled={flash.anyBusy} aria-busy={flash.isBusy("save")}>
            {flash.isBusy("save") ? "Saving…" : editingId ? "Save changes" : "Save connection"}
          </button>
          {editingId ? (
            <>
              {" "}
              <button type="button" onClick={resetForm} disabled={flash.anyBusy}>
                Cancel
              </button>
            </>
          ) : null}
        </div>
      </form>
    </div>
  );
}
