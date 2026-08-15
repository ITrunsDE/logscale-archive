import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:8080",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: process.env.E2E_SKIP_SERVER
    ? undefined
    : {
        command: "node apps/web/dist/main.js",
        cwd: ".",
        url: "http://127.0.0.1:8080/healthz",
        reuseExistingServer: false,
        env: {
          APP_ROLE: "web",
          APP_BIND: "127.0.0.1",
          APP_PORT: "8080",
          DATABASE_URL:
            process.env.DATABASE_URL ??
            "postgres://archive:change-me-local-only@127.0.0.1:5432/archive",
          SESSION_SECRET: "e2e-session-secret-at-least-32-characters-long",
          RECOVERY_SECRET: "e2e-recovery-secret-local-only",
          ENCRYPTION_KEY:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          SECURE_COOKIES: "false",
        },
      },
});
