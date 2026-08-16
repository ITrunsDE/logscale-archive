import { expect, type Page } from "@playwright/test";

export async function signIn(page: Page, username: string, password: string): Promise<void> {
  await page.goto("/");
  await page.waitForLoadState("networkidle");

  const createAdmin = page.getByRole("button", { name: "Create admin" });
  if (await createAdmin.isVisible()) {
    await page.getByLabel("Username").fill(username);
    await page.getByLabel("Password").fill(password);
    await createAdmin.click();
  } else {
    await page.getByLabel("Username").fill(username);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
  }

  await expect(page.getByRole("heading", { name: "Results", exact: true })).toBeVisible();
}

export async function openNav(page: Page, name: string): Promise<void> {
  await page.getByRole("link", { name }).click();
}
