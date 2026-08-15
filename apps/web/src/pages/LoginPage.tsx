import { FormEvent, useState } from "react";
import { Moon, Sun } from "lucide-react";

type AuthUser = {
  id: string;
  username: string;
  role: "admin" | "viewer";
};

type LoginPageProps = {
  mode: "bootstrap" | "login";
  theme: "light" | "dark";
  onToggleTheme: () => void;
  onAuthenticated: (user: AuthUser, csrfToken: string) => void;
};

export function LoginPage({ mode, theme, onToggleTheme, onAuthenticated }: LoginPageProps) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    const endpoint = mode === "bootstrap" ? "/api/auth/bootstrap" : "/api/auth/login";
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const body = await response.json();
      if (!response.ok) {
        if (body.error === "too_many_attempts") {
          setError("Too many failed attempts. Try again later.");
        } else if (body.error === "invalid_password" && Array.isArray(body.details)) {
          setError(body.details.join(" "));
        } else {
          setError("Sign-in failed. Check your credentials.");
        }
        return;
      }
      onAuthenticated(body.user, body.csrfToken);
    } catch {
      setError("Unable to reach the server.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="page-center">
      <button
        type="button"
        className="icon-btn theme-float"
        title={theme === "dark" ? "Switch to light" : "Switch to dark"}
        aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
        onClick={onToggleTheme}
      >
        {theme === "dark" ? (
          <Sun size={18} strokeWidth={1.5} />
        ) : (
          <Moon size={18} strokeWidth={1.5} />
        )}
      </button>
      <form className="panel stack login-panel" onSubmit={onSubmit}>
        <div>
          <h1>Archive</h1>
          <p className="muted">
            {mode === "bootstrap"
              ? "Create the first administrator account."
              : "Sign in to continue."}
          </p>
        </div>

        <label>
          Username
          <input
            autoComplete="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            required
          />
        </label>

        <label>
          Password
          <input
            type="password"
            autoComplete={mode === "bootstrap" ? "new-password" : "current-password"}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </label>

        {error ? <p className="error">{error}</p> : null}

        <button type="submit" disabled={submitting}>
          {mode === "bootstrap" ? "Create admin" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
