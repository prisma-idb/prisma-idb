import { expect, test, type Page } from "@playwright/test";
import { signInAsTestUser } from "./test-utils-signin";

/**
 * Signs in a fresh guest (via the `testUtils` fast path — see
 * test-utils-signin.ts; the real "Continue as guest" click is covered by
 * `test/login.spec.ts`) and lands on the kanban board. Each test gets its
 * own isolated browser context (Playwright default), so each signs in as a
 * distinct guest.
 *
 * Waits for `board-name-input`, not just the heading/"Ready" text: those
 * render as soon as the app shell mounts, before the session check resolves
 * and `loadWorkspace()` finishes mirroring the session user into local IDB
 * (`kanban.status` is still `"opening"` at that point) — a caller that
 * proceeds on the looser signal can race that write, e.g. going offline and
 * reloading before the local user row actually landed.
 */
async function openApp(page: Page) {
  await signInAsTestUser(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Prisma 8 IDB Kanban" })).toBeVisible();
  await expect(page.getByTestId("board-name-input")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Ready")).toBeVisible({ timeout: 15_000 });
}

test("creates, edits, completes, persists, and deletes local records", async ({ page }) => {
  await openApp(page);

  await page.getByTestId("board-name-input").fill("Analytical Engine");
  await page.getByTestId("create-board-submit").click();

  await expect(page.getByRole("textbox", { name: "Board name Analytical Engine" })).toHaveValue("Analytical Engine");
  await expect(page.getByTestId("boards-count")).toHaveText("1");

  await page.getByTestId("todo-title-input").fill("Draft local workflow");
  await page.getByTestId("todo-description-input").fill("Use the auto-migrating IDB client.");
  await page.getByTestId("create-todo-submit").click();

  const todoTitle = page.getByRole("textbox", { name: "Todo title Draft local workflow" });
  const todo = page.getByTestId("todo-item").filter({ has: todoTitle });
  await expect(todo).toBeVisible();
  await expect(todo.getByRole("textbox", { name: "Todo description Draft local workflow" })).toHaveValue(
    "Use the auto-migrating IDB client."
  );

  await todo.getByLabel("Mark todo complete").click();
  await expect(page.getByTestId("done-count")).toHaveText("1/1");

  await todoTitle.fill("Ship local workflow");
  await todo.getByRole("button", { name: "Save todo" }).click();
  await expect(page.getByRole("textbox", { name: "Todo title Ship local workflow" })).toHaveValue(
    "Ship local workflow"
  );

  await page.reload();
  await expect(page.getByText("Ready")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("textbox", { name: "Board name Analytical Engine" })).toHaveValue("Analytical Engine");
  await expect(page.getByRole("textbox", { name: "Todo title Ship local workflow" })).toHaveValue(
    "Ship local workflow"
  );
  await expect(page.getByTestId("done-count")).toHaveText("1/1");

  await page.getByTestId("todo-item").getByRole("button", { name: "Delete todo" }).click();
  await expect(page.getByRole("textbox", { name: "Todo title Ship local workflow" })).not.toBeVisible();

  await page.getByRole("button", { name: "Delete board" }).click();
  await expect(page.getByText("No boards yet")).toBeVisible();
  await expect(page.getByTestId("boards-count")).toHaveText("0");
});

test("a failed todo move keeps the original board selected", async ({ page, context }) => {
  await openApp(page);
  await page.getByTestId("board-name-input").fill("Source");
  await page.getByTestId("create-board-submit").click();
  const source = page
    .getByTestId("board-card")
    .filter({ has: page.getByRole("textbox", { name: "Board name Source" }) });
  await expect(source).toBeVisible();
  await source.getByTestId("todo-title-input").fill("Keep on source");
  await source.getByTestId("create-todo-submit").click();
  const todo = source.getByTestId("todo-item");
  await expect(todo).toBeVisible();
  await page.getByTestId("board-name-input").fill("Destination");
  await page.getByTestId("create-board-submit").click();
  const selector = todo.getByRole("button", { name: "Move todo to board" });
  await expect(selector).toBeEnabled();

  const otherTab = await context.newPage();
  await otherTab.goto("/");
  await expect(otherTab.getByTestId("board-name-input")).toBeVisible({ timeout: 15_000 });
  await context.setOffline(true);
  // Delete in another tab without a sync pull refreshing this tab's board list.
  const destination = otherTab
    .getByTestId("board-card")
    .filter({ has: otherTab.getByRole("textbox", { name: "Board name Destination" }) });
  await destination.getByTestId("delete-board").click();
  await expect(destination).not.toBeVisible();

  await selector.click();
  await page.getByRole("option", { name: "Destination" }).click();
  await expect(source.getByTestId("todo-item")).toHaveCount(1);
  await expect(selector).toHaveText("Source");
});

test("moving a todo requires saving its edits first", async ({ page }) => {
  await openApp(page);
  await page.getByTestId("board-name-input").fill("Source");
  await page.getByTestId("create-board-submit").click();
  const source = page
    .getByTestId("board-card")
    .filter({ has: page.getByRole("textbox", { name: "Board name Source" }) });
  await source.getByTestId("todo-title-input").fill("Draft title");
  await source.getByTestId("create-todo-submit").click();
  await page.getByTestId("board-name-input").fill("Destination");
  await page.getByTestId("create-board-submit").click();
  const todo = source.getByTestId("todo-item");
  const selector = todo.getByRole("button", { name: "Move todo to board" });
  await expect(selector).toBeEnabled();

  await todo.getByTestId("todo-title-field").fill("Edited title");
  await expect(selector).toBeDisabled();

  await todo.getByTestId("save-todo").click();
  await expect(selector).toBeEnabled();
  await selector.click();
  await page.getByRole("option", { name: "Destination" }).click();
  const destination = page
    .getByTestId("board-card")
    .filter({ has: page.getByRole("textbox", { name: "Board name Destination" }) });
  await expect(destination.getByTestId("todo-title-field")).toHaveValue("Edited title");
});

test("switches theme modes and persists explicit choices", async ({ page }) => {
  await openApp(page);

  const toggle = page.getByTestId("theme-toggle");

  // Cycle: system → light → dark
  await toggle.click();
  await toggle.click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect.poll(() => page.evaluate(() => document.documentElement.style.colorScheme)).toBe("dark");

  await page.reload();
  await expect(page.getByText("Ready")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("html")).toHaveClass(/dark/);

  // Cycle: dark → system → light
  await toggle.click();
  await toggle.click();
  await expect(page.locator("html")).not.toHaveClass(/dark/);

  // Cycle: light → dark → system
  await toggle.click();
  await toggle.click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("mode-watcher-mode"))).toBe("system");
});

test("serves PWA metadata and reloads the app shell offline", async ({ page, context, request }) => {
  const manifestResponse = await request.get("/manifest.webmanifest");
  expect(manifestResponse.ok()).toBe(true);
  expect(manifestResponse.headers()["content-type"]).toContain("application/manifest+json");

  const manifest = await manifestResponse.json();
  expect(manifest).toMatchObject({
    name: "Prisma 8 IDB Kanban",
    start_url: "/",
    display: "standalone",
  });
  expect(manifest.icons.map((icon: { src: string }) => icon.src)).toEqual([
    "/icons/icon-144x144.png",
    "/icons/icon-192x192.png",
    "/icons/icon-512x512.png",
  ]);

  const serviceWorkerResponse = await request.get("/service-worker.js");
  expect(serviceWorkerResponse.ok()).toBe(true);
  expect(serviceWorkerResponse.headers()["content-type"]).toContain("javascript");

  await openApp(page);
  await page.evaluate(async () => {
    if (!("serviceWorker" in navigator)) {
      throw new Error("Service workers are not available in this browser context.");
    }
    await navigator.serviceWorker.ready;
  });

  await context.setOffline(true);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Prisma 8 IDB Kanban" })).toBeVisible();
  await expect(page.getByText("Ready")).toBeVisible({ timeout: 15_000 });
  await context.setOffline(false);
});
