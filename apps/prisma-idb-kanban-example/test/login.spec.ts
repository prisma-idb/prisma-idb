import { expect, test } from "@playwright/test";

/**
 * The one test that exercises the real sign-in UI end to end — every other
 * test in this suite signs in via `test-utils-signin.ts`'s fast path
 * (`/api/test/session`) instead, since they're testing something else and
 * don't need to pay for a real navigate+click+fetch+reactivity round trip.
 */
test("continue as guest signs in through the real UI and lands on the dashboard", async ({ page }) => {
  await page.goto("/login");
  await page.getByTestId("continue-as-guest").click();
  await expect(page.getByRole("heading", { name: "Prisma 8 IDB Kanban" })).toBeVisible();
  await expect(page.getByTestId("board-name-input")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Ready")).toBeVisible({ timeout: 15_000 });
});
