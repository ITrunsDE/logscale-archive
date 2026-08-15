import { StrictMode, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import {
  Archive,
  Cable,
  Download,
  FileCode2,
  KeyRound,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Server,
  Sun,
  Users,
} from "lucide-react";
import { LoginPage } from "../pages/LoginPage.js";
import { ConnectionsPage } from "../pages/ConnectionsPage.js";
import { QueryEditorPage } from "../pages/QueryEditorPage.js";
import { RetentionPage } from "../pages/RetentionPage.js";
import { OperationsPage } from "../pages/OperationsPage.js";
import { UsersPage } from "../pages/UsersPage.js";
import { ResultsPage } from "../pages/ResultsPage.js";
import { ExportsPage } from "../pages/ExportsPage.js";
import { ActionFeedbackProvider, useActionFeedback } from "./actionFeedback.js";
import { APP_VERSION } from "../appVersion.js";
import "./styles.css";

type AuthUser = {
  id: string;
  username: string;
  role: "admin" | "viewer";
};

type ExportFilters = {
  queryVersionId: string;
  format: "csv" | "ndjson";
  from?: string;
  to?: string;
  jsonFilters: Array<{ field: string; value: string }>;
};

type AppState =
  | { kind: "loading" }
  | { kind: "bootstrap" }
  | { kind: "login" }
  | { kind: "authenticated"; user: AuthUser; csrfToken: string };

type AppView =
  | "results"
  | "exports"
  | "queries"
  | "connections"
  | "retention"
  | "users"
  | "operations";

type Theme = "light" | "dark";

type StatusPayload = {
  storage: { decision: "allow" | "warn" | "block" };
  worker: { ok: boolean; lastSeen: string | null };
  database: { ok: boolean };
};

const THEME_KEY = "archive-theme";
const SIDEBAR_KEY = "archive-sidebar";

function readStoredTheme(): Theme | null {
  const value = localStorage.getItem(THEME_KEY);
  return value === "light" || value === "dark" ? value : null;
}

function preferredTheme(): Theme {
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function applyTheme(theme: Theme) {
  if (theme === "light") {
    document.documentElement.setAttribute("data-theme", "light");
  } else {
    document.documentElement.removeAttribute("data-theme");
  }
}

applyTheme(readStoredTheme() ?? preferredTheme());

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: "include",
    headers: {
      "content-type": "application/json",
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

function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => readStoredTheme() ?? preferredTheme());

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => {
      if (readStoredTheme() !== null) {
        return;
      }
      const next = media.matches ? "light" : "dark";
      setTheme(next);
      applyTheme(next);
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  function toggleTheme() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    localStorage.setItem(THEME_KEY, next);
    setTheme(next);
  }

  return { theme, toggleTheme };
}

function NavIcon({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}) {
  return (
    <span className="nav-icon" aria-hidden="true" data-active={active ? "true" : undefined}>
      {children}
    </span>
  );
}

function AccountFooter({
  csrfToken,
  username,
  theme,
  collapsed,
  onToggleTheme,
  onToggleCollapsed,
}: {
  csrfToken: string;
  username: string;
  theme: Theme;
  collapsed: boolean;
  onToggleTheme: () => void;
  onToggleCollapsed: () => void;
}) {
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const flash = useActionFeedback();
  const iconProps = { size: 18, strokeWidth: 1.5 } as const;

  function togglePasswordPanel() {
    flash.clear();
    if (collapsed) {
      onToggleCollapsed();
      setPasswordOpen(true);
      return;
    }
    setPasswordOpen((open) => !open);
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (newPassword !== confirmPassword) {
      flash.err("New passwords do not match.");
      return;
    }
    flash.busy("Updating password…", "password");
    try {
      await fetchJson("/api/auth/password", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": csrfToken,
        },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      flash.ok("Password updated.");
    } catch (caught) {
      const body = (caught as { body?: { error?: string; details?: string[] } }).body;
      if (body?.error === "invalid_credentials") {
        flash.err("Current password is wrong.");
      } else if (body?.details?.length) {
        flash.err(body.details.join(" "));
      } else {
        flash.err("Could not change password.");
      }
    }
  }

  return (
    <>
      <p className="muted sidebar-user">{username}</p>
      {passwordOpen ? (
        <form className="account-password-panel stack" onSubmit={(event) => void onSubmit(event)}>
          <p className="muted">Change password</p>
          <label>
            Current
            <input
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              required
            />
          </label>
          <label>
            New
            <input
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              required
            />
          </label>
          <label>
            Confirm
            <input
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              required
            />
          </label>
          <div className="row-actions-tight">
            <button type="submit" disabled={flash.anyBusy} aria-busy={flash.isBusy("password")}>
              {flash.isBusy("password") ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              className="static"
              onClick={() => {
                setPasswordOpen(false);
                flash.clear();
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : null}
      <div className="sidebar-controls">
        <button
          type="button"
          className={`icon-btn${passwordOpen ? " icon-btn-active" : ""}`}
          title="Change password"
          aria-label="Change password"
          aria-expanded={passwordOpen}
          onClick={togglePasswordPanel}
        >
          <KeyRound {...iconProps} />
        </button>
        <button
          type="button"
          className="icon-btn"
          title={theme === "dark" ? "Switch to light" : "Switch to dark"}
          aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          onClick={onToggleTheme}
        >
          {theme === "dark" ? <Sun {...iconProps} /> : <Moon {...iconProps} />}
        </button>
        <button
          type="button"
          className="icon-btn"
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          onClick={onToggleCollapsed}
        >
          {collapsed ? <PanelLeftOpen {...iconProps} /> : <PanelLeftClose {...iconProps} />}
        </button>
      </div>
    </>
  );
}

function App() {
  const [state, setState] = useState<AppState>({ kind: "loading" });
  const [view, setView] = useState<AppView>("results");
  const [exportPreset, setExportPreset] = useState<ExportFilters | null>(null);
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem(SIDEBAR_KEY) === "collapsed",
  );
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const { theme, toggleTheme } = useTheme();

  useEffect(() => {
    void (async () => {
      try {
        const authStatus = await fetchJson<{ needsBootstrap: boolean }>("/api/auth/status");
        if (authStatus.needsBootstrap) {
          setState({ kind: "bootstrap" });
          return;
        }
        const me = await fetchJson<{ user: AuthUser; csrfToken: string }>("/api/auth/me");
        setState({ kind: "authenticated", user: me.user, csrfToken: me.csrfToken });
      } catch {
        setState({ kind: "login" });
      }
    })();
  }, []);

  useEffect(() => {
    if (state.kind !== "authenticated" || state.user.role !== "admin") {
      return;
    }
    let cancelled = false;
    async function loadStatus() {
      try {
        const next = await fetchJson<StatusPayload>("/api/status");
        if (!cancelled) {
          setStatus(next);
        }
      } catch {
        if (!cancelled) {
          setStatus(null);
        }
      }
    }
    void loadStatus();
    const timer = window.setInterval(() => void loadStatus(), 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [state]);

  function toggleCollapsed() {
    const next = !collapsed;
    setCollapsed(next);
    localStorage.setItem(SIDEBAR_KEY, next ? "collapsed" : "expanded");
  }

  if (state.kind === "loading") {
    return <div className="page-center muted">Loading…</div>;
  }

  if (state.kind === "bootstrap" || state.kind === "login") {
    return (
      <LoginPage
        mode={state.kind}
        theme={theme}
        onToggleTheme={toggleTheme}
        onAuthenticated={(user, csrfToken) =>
          setState({ kind: "authenticated", user, csrfToken })
        }
      />
    );
  }

  const isAdmin = state.user.role === "admin";
  const iconProps = { size: 18, strokeWidth: 1.5 } as const;

  function navClass(active: boolean) {
    return active ? "nav-active" : undefined;
  }

  function diskStampClass() {
    if (!status) {
      return "stamp stamp-held";
    }
    if (status.storage.decision === "block") {
      return "stamp stamp-failed";
    }
    if (status.storage.decision === "warn") {
      return "stamp stamp-held";
    }
    return "stamp stamp-complete";
  }

  return (
    <div className={`app-frame${collapsed ? " sidebar-collapsed" : ""}`}>
      <aside className="app-sidebar">
        <div className="app-brand" title={`Archive · LogScale v${APP_VERSION}`}>
          <h1>Archive</h1>
          <p className="muted caption">
            LogScale <span className="app-version">v{APP_VERSION}</span>
          </p>
        </div>
        <nav className="app-nav">
          <a
            href="#results"
            className={navClass(view === "results")}
            title="Results"
            onClick={() => setView("results")}
          >
            <NavIcon active={view === "results"}>
              <Search {...iconProps} fill={view === "results" ? "currentColor" : "none"} />
            </NavIcon>
            <span className="nav-label">Results</span>
          </a>
          <a
            href="#exports"
            className={navClass(view === "exports")}
            title="Exports"
            onClick={() => setView("exports")}
          >
            <NavIcon active={view === "exports"}>
              <Download {...iconProps} fill={view === "exports" ? "currentColor" : "none"} />
            </NavIcon>
            <span className="nav-label">Exports</span>
          </a>
          {isAdmin ? (
            <>
              <div className="app-nav-divider" />
              <a
                href="#queries"
                className={navClass(view === "queries")}
                title="Queries"
                onClick={() => setView("queries")}
              >
                <NavIcon active={view === "queries"}>
                  <FileCode2 {...iconProps} fill={view === "queries" ? "currentColor" : "none"} />
                </NavIcon>
                <span className="nav-label">Queries</span>
              </a>
              <a
                href="#connections"
                className={navClass(view === "connections")}
                title="Connections"
                onClick={() => setView("connections")}
              >
                <NavIcon active={view === "connections"}>
                  <Cable {...iconProps} fill={view === "connections" ? "currentColor" : "none"} />
                </NavIcon>
                <span className="nav-label">Connections</span>
              </a>
              <a
                href="#retention"
                className={navClass(view === "retention")}
                title="Retention"
                onClick={() => setView("retention")}
              >
                <NavIcon active={view === "retention"}>
                  <Archive {...iconProps} fill={view === "retention" ? "currentColor" : "none"} />
                </NavIcon>
                <span className="nav-label">Retention</span>
              </a>
              <a
                href="#users"
                className={navClass(view === "users")}
                title="Users"
                onClick={() => setView("users")}
              >
                <NavIcon active={view === "users"}>
                  <Users {...iconProps} fill={view === "users" ? "currentColor" : "none"} />
                </NavIcon>
                <span className="nav-label">Users</span>
              </a>
              <a
                href="#operations"
                className={navClass(view === "operations")}
                title="Operations"
                onClick={() => setView("operations")}
              >
                <NavIcon active={view === "operations"}>
                  <Server {...iconProps} fill={view === "operations" ? "currentColor" : "none"} />
                </NavIcon>
                <span className="nav-label">Operations</span>
              </a>
            </>
          ) : null}
        </nav>

        <div className="app-sidebar-footer">
          {isAdmin && status ? (
            <div className="sidebar-health" aria-label="System health">
              <span className={diskStampClass()} title={`Disk: ${status.storage.decision}`}>
                Disk
              </span>
              <span
                className={`stamp ${status.worker.ok ? "stamp-complete" : "stamp-failed"}`}
                title={status.worker.lastSeen ? `Worker last seen ${status.worker.lastSeen}` : "Worker down"}
              >
                Worker
              </span>
              <span
                className={`stamp ${status.database.ok ? "stamp-complete" : "stamp-failed"}`}
                title={status.database.ok ? "Database ok" : "Database down"}
              >
                DB
              </span>
            </div>
          ) : null}
          <AccountFooter
            csrfToken={state.csrfToken}
            username={state.user.username}
            theme={theme}
            collapsed={collapsed}
            onToggleTheme={toggleTheme}
            onToggleCollapsed={toggleCollapsed}
          />
        </div>
      </aside>

      <main className="app-main stack">
        {view === "results" ? (
          <ResultsPage
            user={state.user}
            csrfToken={state.csrfToken}
            onRequestExport={(filters) => {
              setExportPreset(filters);
              setView("exports");
            }}
          />
        ) : null}
        {view === "exports" ? (
          <ExportsPage
            user={state.user}
            csrfToken={state.csrfToken}
            presetFilters={exportPreset}
            onPresetConsumed={() => setExportPreset(null)}
          />
        ) : null}
        {isAdmin && view === "queries" ? (
          <QueryEditorPage user={state.user} csrfToken={state.csrfToken} />
        ) : null}
        {isAdmin && view === "connections" ? (
          <ConnectionsPage user={state.user} csrfToken={state.csrfToken} />
        ) : null}
        {isAdmin && view === "retention" ? (
          <RetentionPage user={state.user} csrfToken={state.csrfToken} />
        ) : null}
        {isAdmin && view === "users" ? (
          <UsersPage user={state.user} csrfToken={state.csrfToken} />
        ) : null}
        {isAdmin && view === "operations" ? (
          <OperationsPage user={state.user} csrfToken={state.csrfToken} />
        ) : null}
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ActionFeedbackProvider>
      <App />
    </ActionFeedbackProvider>
  </StrictMode>,
);
