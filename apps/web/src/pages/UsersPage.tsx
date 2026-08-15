import { FormEvent, useEffect, useState } from "react";

type AuthUser = {
  id: string;
  username: string;
  role: "admin" | "viewer";
};

type PublicUser = AuthUser & {
  createdAt: string;
  updatedAt: string;
};

type PasswordPolicy = {
  minLength: number;
  requireUpper: boolean;
  requireLower: boolean;
  requireDigit: boolean;
  requireSymbol: boolean;
  historyCount: number;
};

type UsersPageProps = {
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

export function UsersPage({ user, csrfToken }: UsersPageProps) {
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [policy, setPolicy] = useState<PasswordPolicy | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"admin" | "viewer">("viewer");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [resetUserId, setResetUserId] = useState<string | null>(null);
  const [resetPassword, setResetPassword] = useState("");
  const [generatedPassword, setGeneratedPassword] = useState<string | null>(null);

  async function reload() {
    const [usersResponse, policyResponse] = await Promise.all([
      api<{ users: PublicUser[] }>(csrfToken, "/api/admin/users"),
      api<{ policy: PasswordPolicy }>(csrfToken, "/api/admin/password-policy"),
    ]);
    setUsers(usersResponse.users);
    setPolicy(policyResponse.policy);
  }

  useEffect(() => {
    void reload().catch(() => setError("Failed to load users."));
  }, [csrfToken]);

  async function onCreateUser(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setMessage(null);
    try {
      await api(csrfToken, "/api/admin/users", {
        method: "POST",
        body: JSON.stringify({ username, password, role }),
      });
      setUsername("");
      setPassword("");
      setMessage("User created.");
      await reload();
    } catch (caught) {
      const body = (caught as { body?: { details?: string[] } }).body;
      if (body?.details?.length) {
        setError(body.details.join(" "));
      } else {
        setError("Could not create user.");
      }
    }
  }

  async function onRevokeSessions(userId: string) {
    setError(null);
    setMessage(null);
    try {
      const result = await api<{ revoked: number }>(
        csrfToken,
        `/api/admin/users/${userId}/revoke-sessions`,
        { method: "POST", body: "{}" },
      );
      setMessage(`Revoked ${result.revoked} session(s).`);
    } catch {
      setError("Could not revoke sessions.");
    }
  }

  async function onSetPassword(event: FormEvent) {
    event.preventDefault();
    if (!resetUserId) {
      return;
    }
    setError(null);
    setMessage(null);
    setGeneratedPassword(null);
    try {
      await api(csrfToken, `/api/admin/users/${resetUserId}/password`, {
        method: "POST",
        body: JSON.stringify({ password: resetPassword }),
      });
      setResetPassword("");
      setResetUserId(null);
      setMessage("Password reset. All sessions for that user were revoked.");
    } catch (caught) {
      const body = (caught as { body?: { details?: string[] } }).body;
      if (body?.details?.length) {
        setError(body.details.join(" "));
      } else {
        setError("Could not reset password.");
      }
    }
  }

  async function onGeneratePassword(userId: string) {
    setError(null);
    setMessage(null);
    setGeneratedPassword(null);
    try {
      const result = await api<{ ok: true; generatedPassword: string }>(
        csrfToken,
        `/api/admin/users/${userId}/password`,
        { method: "POST", body: JSON.stringify({ generate: true }) },
      );
      setGeneratedPassword(result.generatedPassword);
      setResetUserId(userId);
      setMessage("Temporary password generated. Copy it now — it will not be shown again.");
    } catch {
      setError("Could not generate password.");
    }
  }

  async function onSavePolicy(event: FormEvent) {
    event.preventDefault();
    if (!policy) {
      return;
    }
    setError(null);
    setMessage(null);
    try {
      const result = await api<{ policy: PasswordPolicy }>(csrfToken, "/api/admin/password-policy", {
        method: "PUT",
        body: JSON.stringify(policy),
      });
      setPolicy(result.policy);
      setMessage("Password policy updated.");
    } catch {
      setError("Could not update password policy.");
    }
  }

  return (
    <div className="stack">
      <header>
        <h1>Users</h1>
        <p className="muted">Signed in as {user.username}</p>
      </header>

      {error ? <p className="error">{error}</p> : null}
      {message ? <p className="muted">{message}</p> : null}
      {generatedPassword ? (
        <p className="mono generated-password panel">
          Generated password: {generatedPassword}
        </p>
      ) : null}

      <section className="panel stack">
        <h2>Accounts</h2>
        <table>
          <thead>
            <tr>
              <th>Username</th>
              <th>Role</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((entry) => (
              <tr key={entry.id}>
                <td>{entry.username}</td>
                <td>{entry.role}</td>
                <td>
                  <div className="row-actions-tight">
                    <button type="button" onClick={() => void onRevokeSessions(entry.id)}>
                      Revoke sessions
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setResetUserId(entry.id);
                        setResetPassword("");
                        setGeneratedPassword(null);
                      }}
                    >
                      Set password
                    </button>
                    <button type="button" onClick={() => void onGeneratePassword(entry.id)}>
                      Generate
                    </button>
                  </div>
                  {resetUserId === entry.id && !generatedPassword ? (
                    <form className="reset-panel stack" onSubmit={onSetPassword}>
                      <label>
                        New password
                        <input
                          type="password"
                          value={resetPassword}
                          onChange={(event) => setResetPassword(event.target.value)}
                          required
                          autoComplete="new-password"
                        />
                      </label>
                      <div className="row-actions-tight">
                        <button type="submit">Save password</button>
                        <button type="button" onClick={() => setResetUserId(null)}>
                          Cancel
                        </button>
                      </div>
                    </form>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <form className="panel stack" onSubmit={onCreateUser}>
        <h2>Create user</h2>
        <label>
          Username
          <input value={username} onChange={(event) => setUsername(event.target.value)} required />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </label>
        <label>
          Role
          <select value={role} onChange={(event) => setRole(event.target.value as "admin" | "viewer")}>
            <option value="viewer">Viewer</option>
            <option value="admin">Admin</option>
          </select>
        </label>
        <button type="submit">Create user</button>
      </form>

      {policy ? (
        <form className="panel stack" onSubmit={onSavePolicy}>
          <h2>Password policy</h2>
          <label>
            Minimum length
            <input
              type="number"
              min={12}
              value={policy.minLength}
              onChange={(event) =>
                setPolicy({ ...policy, minLength: Number(event.target.value) })
              }
            />
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={policy.requireUpper}
              onChange={(event) =>
                setPolicy({ ...policy, requireUpper: event.target.checked })
              }
            />
            Require uppercase
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={policy.requireLower}
              onChange={(event) =>
                setPolicy({ ...policy, requireLower: event.target.checked })
              }
            />
            Require lowercase
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={policy.requireDigit}
              onChange={(event) =>
                setPolicy({ ...policy, requireDigit: event.target.checked })
              }
            />
            Require digit
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={policy.requireSymbol}
              onChange={(event) =>
                setPolicy({ ...policy, requireSymbol: event.target.checked })
              }
            />
            Require symbol
          </label>
          <button type="submit">Save policy</button>
        </form>
      ) : null}
    </div>
  );
}
