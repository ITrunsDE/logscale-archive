import { FormEvent, useEffect, useState } from "react";
import { useActionFeedback } from "../client/actionFeedback.js";

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
      ...(init?.body ? { "content-type": "application/json" } : {}),
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
  const flash = useActionFeedback();
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [policy, setPolicy] = useState<PasswordPolicy | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"admin" | "viewer">("viewer");
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
    void reload().catch(() => flash.err("Failed to load users."));
  }, [csrfToken]);

  async function onCreateUser(event: FormEvent) {
    event.preventDefault();
    flash.busy("Creating user…", "create");
    try {
      await api(csrfToken, "/api/admin/users", {
        method: "POST",
        body: JSON.stringify({ username, password, role }),
      });
      setUsername("");
      setPassword("");
      flash.ok("User created.");
      await reload();
    } catch (caught) {
      const body = (caught as { body?: { details?: string[] } }).body;
      if (body?.details?.length) {
        flash.err(body.details.join(" "));
      } else {
        flash.err("Could not create user.");
      }
    }
  }

  async function onRevokeSessions(userId: string) {
    flash.busy("Revoking sessions…", `revoke:${userId}`);
    try {
      const result = await api<{ revoked: number }>(
        csrfToken,
        `/api/admin/users/${userId}/revoke-sessions`,
        { method: "POST", body: "{}" },
      );
      flash.ok(`Revoked ${result.revoked} session(s).`);
    } catch {
      flash.err("Could not revoke sessions.");
    }
  }

  async function onDeleteUser(entry: PublicUser) {
    if (!window.confirm(`Delete user “${entry.username}”?`)) {
      return;
    }
    flash.busy("Deleting user…", `delete:${entry.id}`);
    try {
      await api(csrfToken, `/api/admin/users/${entry.id}`, { method: "DELETE" });
      flash.ok("User deleted.");
      await reload();
    } catch {
      flash.err("Could not delete user.");
    }
  }

  async function onSetPassword(event: FormEvent) {
    event.preventDefault();
    if (!resetUserId) {
      return;
    }
    setGeneratedPassword(null);
    flash.busy("Resetting password…", "set-password");
    try {
      await api(csrfToken, `/api/admin/users/${resetUserId}/password`, {
        method: "POST",
        body: JSON.stringify({ password: resetPassword }),
      });
      setResetPassword("");
      setResetUserId(null);
      flash.ok("Password reset. All sessions for that user were revoked.");
    } catch (caught) {
      const body = (caught as { body?: { details?: string[] } }).body;
      if (body?.details?.length) {
        flash.err(body.details.join(" "));
      } else {
        flash.err("Could not reset password.");
      }
    }
  }

  async function onGeneratePassword(userId: string) {
    setGeneratedPassword(null);
    flash.busy("Generating password…", `generate:${userId}`);
    try {
      const result = await api<{ ok: true; generatedPassword: string }>(
        csrfToken,
        `/api/admin/users/${userId}/password`,
        { method: "POST", body: JSON.stringify({ generate: true }) },
      );
      setGeneratedPassword(result.generatedPassword);
      setResetUserId(userId);
      flash.ok("Temporary password generated. Copy it now — it will not be shown again.");
    } catch {
      flash.err("Could not generate password.");
    }
  }

  async function onSavePolicy(event: FormEvent) {
    event.preventDefault();
    if (!policy) {
      return;
    }
    flash.busy("Saving policy…", "policy");
    try {
      const result = await api<{ policy: PasswordPolicy }>(csrfToken, "/api/admin/password-policy", {
        method: "PUT",
        body: JSON.stringify(policy),
      });
      setPolicy(result.policy);
      flash.ok("Password policy updated.");
    } catch {
      flash.err("Could not update password policy.");
    }
  }

  return (
    <div className="stack">
      <header>
        <h1>Users</h1>
        <p className="muted">Signed in as {user.username}</p>
      </header>

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
                    <button
                      type="button"
                      disabled={flash.anyBusy}
                      aria-busy={flash.isBusy(`revoke:${entry.id}`)}
                      onClick={() => void onRevokeSessions(entry.id)}
                    >
                      {flash.isBusy(`revoke:${entry.id}`) ? "Revoking…" : "Revoke sessions"}
                    </button>
                    <button
                      type="button"
                      disabled={flash.anyBusy}
                      onClick={() => {
                        setResetUserId(entry.id);
                        setResetPassword("");
                        setGeneratedPassword(null);
                      }}
                    >
                      Set password
                    </button>
                    <button
                      type="button"
                      disabled={flash.anyBusy}
                      aria-busy={flash.isBusy(`generate:${entry.id}`)}
                      onClick={() => void onGeneratePassword(entry.id)}
                    >
                      {flash.isBusy(`generate:${entry.id}`) ? "Generating…" : "Generate"}
                    </button>
                    {entry.username !== "admin" ? (
                      <button
                        type="button"
                        disabled={flash.anyBusy}
                        aria-busy={flash.isBusy(`delete:${entry.id}`)}
                        onClick={() => void onDeleteUser(entry)}
                      >
                        {flash.isBusy(`delete:${entry.id}`) ? "Deleting…" : "Delete"}
                      </button>
                    ) : null}
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
                        <button
                          type="submit"
                          disabled={flash.anyBusy}
                          aria-busy={flash.isBusy("set-password")}
                        >
                          {flash.isBusy("set-password") ? "Saving…" : "Save password"}
                        </button>
                        <button type="button" onClick={() => setResetUserId(null)} disabled={flash.anyBusy}>
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
        <button type="submit" disabled={flash.anyBusy} aria-busy={flash.isBusy("create")}>
          {flash.isBusy("create") ? "Creating…" : "Create user"}
        </button>
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
          <button type="submit" disabled={flash.anyBusy} aria-busy={flash.isBusy("policy")}>
            {flash.isBusy("policy") ? "Saving…" : "Save policy"}
          </button>
        </form>
      ) : null}
    </div>
  );
}
