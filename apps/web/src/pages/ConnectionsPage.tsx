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
  const [connections, setConnections] = useState<PublicConnection[]>([]);
  const [name, setName] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [repository, setRepository] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [validation, setValidation] = useState<ConnectionValidation | null>(null);

  async function reload() {
    const result = await api<{ connections: PublicConnection[] }>(
      csrfToken,
      "/api/admin/logscale-connections",
    );
    setConnections(result.connections);
  }

  useEffect(() => {
    void reload().catch(() => setError("Failed to load connections."));
  }, [csrfToken]);

  async function onCreate(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setMessage(null);
    setValidation(null);
    try {
      await api(csrfToken, "/api/admin/logscale-connections", {
        method: "POST",
        body: JSON.stringify({ name, endpoint, repository, token }),
      });
      setName("");
      setEndpoint("");
      setRepository("");
      setToken("");
      setMessage("Connection saved. Token is stored encrypted and is not shown again.");
      await reload();
    } catch {
      setError("Could not save connection.");
    }
  }

  async function onValidate(connectionId: string) {
    setError(null);
    setMessage(null);
    setValidation(null);
    try {
      const result = await api<{ connection: PublicConnection; validation: ConnectionValidation }>(
        csrfToken,
        `/api/admin/logscale-connections/${connectionId}/validate`,
        { method: "POST", body: "{}" },
      );
      setValidation(result.validation);
      setMessage(`Validation finished with status ${result.connection.status}.`);
      await reload();
    } catch {
      setError("Could not validate connection.");
    }
  }

  async function onDelete(connectionId: string) {
    setError(null);
    setMessage(null);
    setValidation(null);
    try {
      await api(csrfToken, `/api/admin/logscale-connections/${connectionId}`, {
        method: "DELETE",
        body: "{}",
      });
      setMessage("Connection deleted.");
      await reload();
    } catch {
      setError("Could not delete connection.");
    }
  }

  return (
    <div className="stack">
      <header>
        <h1>LogScale connections</h1>
        <p className="muted">Signed in as {user.username}</p>
      </header>

      {error ? <p className="error">{error}</p> : null}
      {message ? <p className="muted">{message}</p> : null}

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
                  <button type="button" onClick={() => void onValidate(connection.id)}>
                    Validate
                  </button>{" "}
                  <button type="button" onClick={() => void onDelete(connection.id)}>
                    Delete
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

      <form className="panel stack" onSubmit={onCreate}>
        <h2>Add connection</h2>
        <p className="muted">
          Tokens are encrypted at rest. Only name, endpoint, repository, and status are shown after
          save.
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
            placeholder="https://cloud.falcon.humio.com"
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
            required
          />
        </label>
        <button type="submit">Save connection</button>
      </form>
    </div>
  );
}
