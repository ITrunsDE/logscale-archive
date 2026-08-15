import { expect, test } from "@playwright/test";

async function signInAsAdmin(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/");

  const bootstrap = page.getByText("Create the first administrator account.");
  if (await bootstrap.isVisible()) {
    await page.getByLabel("Username").fill("admin");
    await page.getByLabel("Password").fill("bootstrap-password-14");
    await page.getByRole("button", { name: "Create admin" }).click();
    return;
  }

  await page.getByLabel("Username").fill("admin");
  await page.getByLabel("Password").fill("bootstrap-password-14");
  await page.getByRole("button", { name: "Sign in" }).click();
}

test.describe("query editor browser flow", () => {
  test("rejects invalid draft query text in the UI", async ({ page }) => {
    await signInAsAdmin(page);

    await page.getByRole("link", { name: "Queries" }).click();
    await expect(page.getByRole("heading", { name: "Query editor" })).toBeVisible();

    const connectionForm = page.getByRole("heading", { name: "Add connection" }).locator("..");
    await connectionForm.getByLabel("Name").fill("E2E");
    await connectionForm.getByLabel("Endpoint").fill("https://logscale-e2e.example");
    await connectionForm.getByLabel("Repository").fill("repo-a");
    await connectionForm.getByLabel("Token").fill("e2e-query-token");
    await connectionForm.getByRole("button", { name: "Save connection" }).click();
    await expect(page.getByText("Connection saved. Token is stored encrypted")).toBeVisible();
    await page.reload();
    await page.getByRole("link", { name: "Queries" }).click();

    const draftForm = page.getByRole("heading", { name: "Draft configuration" }).locator("..");
    await expect(draftForm.getByLabel("Connection")).toContainText("E2E");
    await draftForm.getByLabel("Connection").selectOption({ label: "E2E (repo-a)" });
    await draftForm.getByLabel("Query name").fill("events");
    await draftForm.getByRole("button", { name: "Event" }).click();
    await draftForm.getByLabel("Query text").fill("#repo=repo-a | head(1)");
    await draftForm.getByRole("button", { name: "Save draft" }).click();

    await expect(page.getByText("head() is not allowed")).toBeVisible();
  });
});
