import { expect, test } from "@playwright/test";
import { openNav, signIn } from "./helpers";

test.describe("operations and maintenance UI", () => {
  test("admin can open operations page with health stamps", async ({ page }) => {
    await signIn(page, "admin", "bootstrap-password-14");
    await openNav(page, "Operations");
    await expect(page.getByRole("heading", { name: "Operations", exact: true })).toBeVisible();
    await expect(page.getByText("Disk:")).toBeVisible();
    await expect(page.getByText("Worker:")).toBeVisible();
    await expect(page.getByText("Database:")).toBeVisible();
    await expect(page.getByText("Dangerous restore")).toBeVisible();
  });
});
