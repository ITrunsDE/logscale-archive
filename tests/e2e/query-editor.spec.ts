import { expect, test } from "@playwright/test";
import { openNav, signIn } from "./helpers";

test.describe("query editor browser flow", () => {
  test("rejects invalid draft query text in the UI", async ({ page }) => {
    await signIn(page, "admin", "bootstrap-password-14");

    await openNav(page, "Connections");
    await expect(page.getByRole("heading", { name: "LogScale connections" })).toBeVisible();

    const connectionForm = page.getByRole("heading", { name: "Add connection" }).locator("..");
    await connectionForm.getByLabel("Name").fill("E2E");
    await connectionForm.getByLabel("Endpoint").fill("http://127.0.0.1:1");
    await connectionForm.getByLabel("Repository").fill("repo-a");
    await connectionForm.getByLabel("Token").fill("e2e-query-token");
    await connectionForm.getByRole("button", { name: "Save connection" }).click();
    await expect(page.getByText("Connection saved.")).toBeVisible();

    await openNav(page, "Queries");
    await expect(page.getByRole("heading", { name: "Query editor" })).toBeVisible();

    await page.getByLabel("Connection").selectOption({ label: "E2E (repo-a)" });
    await page.getByLabel("Query name").fill("events");
    await page.getByLabel("Query text").fill("#repo=repo-a | head(1)");
    await page.getByRole("button", { name: "Save draft" }).click();

    await expect(page.getByText("head() is not allowed")).toBeVisible();
  });
});
