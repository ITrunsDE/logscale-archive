import { expect, test } from "@playwright/test";

async function signIn(
  page: import("@playwright/test").Page,
  username: string,
  password: string,
): Promise<void> {
  await page.goto("/");
  await page.waitForLoadState("networkidle");

  const createAdmin = page.getByRole("button", { name: "Create admin" });
  if (await createAdmin.isVisible()) {
    await page.getByLabel("Username").fill(username);
    await page.getByLabel("Password").fill(password);
    await createAdmin.click();
    await expect(page.getByRole("heading", { name: "Results", exact: true })).toBeVisible();
    return;
  }

  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Results", exact: true })).toBeVisible();
}

test.describe("operations and maintenance UI", () => {
  test("admin can open operations page with health stamps", async ({ page }) => {
    await signIn(page, "admin", "bootstrap-password-14");
    await page.getByRole("link", { name: "Operations" }).click();
    await expect(page.getByRole("heading", { name: "Operations", exact: true })).toBeVisible();
    await expect(page.getByText("Disk:")).toBeVisible();
    await expect(page.getByText("Worker:")).toBeVisible();
    await expect(page.getByText("Database:")).toBeVisible();
    await expect(page.getByText("Dangerous restore")).toBeVisible();
  });
});
