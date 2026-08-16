import { expect, test } from "@playwright/test";
import { openNav, signIn } from "./helpers";

async function ensureViewerExists(page: import("@playwright/test").Page): Promise<void> {
  await signIn(page, "admin", "bootstrap-password-14");
  await openNav(page, "Users");
  if (await page.getByText("viewer-e2e").count()) {
    return;
  }

  const form = page.getByRole("heading", { name: "Create user" }).locator("..");
  await form.getByLabel("Username").fill("viewer-e2e");
  await form.getByLabel("Password").fill("viewer-password-14");
  await form.getByLabel("Role").selectOption("viewer");
  await form.getByRole("button", { name: "Create user" }).click();
  await expect(page.getByText("viewer-e2e")).toBeVisible();
}

test.describe("archived results and exports", () => {
  test("admin lands on Results and archived search avoids LogScale", async ({ page }) => {
    let logscaleRequests = 0;
    await page.route("**/*", async (route) => {
      const url = route.request().url();
      if (url.includes("logscale") || url.includes("queryjobs")) {
        logscaleRequests += 1;
      }
      await route.continue();
    });

    await signIn(page, "admin", "bootstrap-password-14");
    await expect(page.getByText("Archived data only")).toBeVisible();

    const apiStatus = await page.evaluate(async () => {
      const versions = await fetch("/api/results/query-versions", { credentials: "include" });
      if (versions.status !== 200) {
        return versions.status;
      }
      const csrf = await fetch("/api/auth/me", { credentials: "include" }).then((response) =>
        response.json(),
      );
      const search = await fetch("/api/results/search", {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": csrf.csrfToken,
        },
        body: JSON.stringify({ queryVersionId: "00000000-0000-0000-0000-000000000000" }),
      });
      return search.status;
    });
    expect([404, 400]).toContain(apiStatus);
    expect(logscaleRequests).toBe(0);
  });

  test("viewer can reach exports without admin navigation", async ({ page }) => {
    await ensureViewerExists(page);
    await page.context().clearCookies();
    await signIn(page, "viewer-e2e", "viewer-password-14");

    await expect(page.getByRole("link", { name: "Connections" })).toHaveCount(0);
    await page.getByRole("link", { name: "Exports" }).click();
    await expect(page.getByRole("heading", { name: "Exports" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Request export" })).toBeVisible();
  });
});
