import pg from "pg";
import { expect, test } from "@playwright/test";

test.describe("auth browser flow", () => {
  test("bootstrap, login, and admin user management", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByRole("heading", { name: "Archive" })).toBeVisible();
    await expect(page.getByText("Create the first administrator account.")).toBeVisible();

    await page.getByLabel("Username").fill("admin");
    await page.getByLabel("Password").fill("bootstrap-password-14");
    await page.getByRole("button", { name: "Create admin" }).click();

    await expect(page.getByRole("heading", { name: "Users" })).toBeVisible();
    await expect(page.locator("#users").getByText("Signed in as admin")).toBeVisible();

    const createUser = page.getByRole("heading", { name: "Create user" }).locator("..");
    await createUser.getByLabel("Username").fill("viewer1");
    await createUser.getByLabel("Password").fill("viewer-password-14");
    await createUser.getByLabel("Role").selectOption("viewer");
    await createUser.getByRole("button", { name: "Create user" }).click();

    await expect(page.getByRole("cell", { name: "viewer1" })).toBeVisible();
    await page.getByRole("button", { name: "Delete" }).click();

    await expect(page.getByRole("cell", { name: "viewer1" })).not.toBeVisible();
  });
});
