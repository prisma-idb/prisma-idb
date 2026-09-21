import type { Page } from "@playwright/test";
import { expect, test } from "./cross-device-fixtures";

/** Waits for a manually-triggered sync cycle (push, then pull) to fully complete. */
async function syncNow(page: Page): Promise<void> {
  await Promise.all([
    page.waitForResponse((resp) => resp.url().includes("/api/sync/pull") && resp.status() === 200),
    page.getByTestId("sync-now").click(),
  ]);
}

function boardCard(page: Page, name: string) {
  return page.getByTestId("board-card").filter({ has: page.getByRole("textbox", { name: `Board name ${name}` }) });
}

function todoItem(page: Page, title: string) {
  return page.getByTestId("todo-item").filter({ has: page.getByRole("textbox", { name: `Todo title ${title}` }) });
}

async function createBoard(page: Page, name: string): Promise<void> {
  await page.getByTestId("board-name-input").fill(name);
  await page.getByTestId("create-board-submit").click();
  await expect(boardCard(page, name)).toBeVisible();
}

test("a board created on one device appears on another after sync", async ({ devices }) => {
  const [pageA, pageB] = devices;
  const boardName = `Sync Board ${Date.now()}`;

  await createBoard(pageA, boardName);
  await syncNow(pageA);
  await syncNow(pageB);

  await expect(boardCard(pageB, boardName)).toBeVisible();
});

/**
 * Regression test for the bug that motivated this suite: board rename,
 * todo edit, and toggle-complete all go through `.where({ id }).update(...)`
 * with no scalar FK field in the patch — the plan-level path in
 * sync-executor.ts that used to write the outbox payload as `{ patch, where:
 * <raw filter tree> }` instead of `{ patch, key }`. The server had no way to
 * turn a filter tree back into a primary key, so authorization silently
 * failed (SCOPE_VIOLATION, non-retryable) and every plain field update was
 * dropped without any visible error.
 */
test("board rename, todo edit, and toggle-complete sync to another device", async ({ devices }) => {
  const [pageA, pageB] = devices;
  const boardName = `Update Board ${Date.now()}`;

  await createBoard(pageA, boardName);
  const cardA = boardCard(pageA, boardName);
  await cardA.getByTestId("todo-title-input").fill("Original title");
  await cardA.getByTestId("create-todo-submit").click();
  await expect(todoItem(pageA, "Original title")).toBeVisible();

  await syncNow(pageA);
  await syncNow(pageB);
  await expect(boardCard(pageB, boardName)).toBeVisible();
  await expect(todoItem(pageB, "Original title")).toBeVisible();

  const renamedBoard = `${boardName} (renamed)`;
  await cardA.getByTestId("board-name-field").fill(renamedBoard);
  await cardA.getByTestId("save-board").click();
  await expect(boardCard(pageA, renamedBoard)).toBeVisible();

  const todoA = todoItem(pageA, "Original title");
  await todoA.getByTestId("todo-title-field").fill("Updated title");
  await todoA.getByTestId("todo-description-field").fill("Updated description");
  await todoA.getByTestId("save-todo").click();
  await expect(todoItem(pageA, "Updated title")).toBeVisible();
  await todoItem(pageA, "Updated title").getByTestId("toggle-todo").click();
  await expect(todoItem(pageA, "Updated title").getByTestId("toggle-todo")).toHaveAttribute(
    "aria-label",
    "Mark todo incomplete"
  );

  await syncNow(pageA);
  await syncNow(pageB);

  await expect(boardCard(pageB, renamedBoard)).toBeVisible();
  // `todo-description-field` (like `board-name-field`/`todo-title-field`) is
  // a one-time-initialized local edit buffer (see TodoItem.svelte's doc
  // comment) — it deliberately does NOT reactively pick up a store update
  // on an already-mounted instance, so a stale value here would only prove
  // the UI doesn't clobber an in-progress edit, not that the sync failed.
  // Reload to mount fresh from the (now pulled-and-updated) store state,
  // the same way kanban.spec.ts's own persistence test verifies data.
  await pageB.reload();
  await expect(pageB.getByTestId("board-name-input")).toBeVisible({ timeout: 15_000 });

  await expect(boardCard(pageB, renamedBoard)).toBeVisible();
  const todoB = todoItem(pageB, "Updated title");
  await expect(todoB).toBeVisible();
  await expect(todoB.getByTestId("todo-description-field")).toHaveValue("Updated description");
  await expect(todoB.getByTestId("toggle-todo")).toHaveAttribute("aria-label", "Mark todo incomplete");
});

/**
 * Deleting a board cascades locally to its todos (client-idb's
 * `onDelete: cascade`), producing THREE outbox delete events — both todos,
 * then the board. The children must reach and be authorized on the server
 * BEFORE the board itself: a Todo's ownership is resolved by walking
 * Todo→Board→User, which breaks once the Board row is gone. This only works
 * because the outbox's push order is guaranteed FIFO by `createdAt` — see
 * the monotonic-timestamp fix in sync-executor.ts (plain `new Date()` can
 * tie at millisecond resolution across a synchronous cascade, which would
 * scramble this order and fail the children's deletes with SCOPE_VIOLATION).
 */
test("deleting a board cascade-deletes its todos, and both are gone on another device after sync", async ({
  devices,
}) => {
  const [pageA, pageB] = devices;
  const boardName = `Cascade Board ${Date.now()}`;

  await createBoard(pageA, boardName);
  const cardA = boardCard(pageA, boardName);
  await cardA.getByTestId("todo-title-input").fill("Cascade todo 1");
  await cardA.getByTestId("create-todo-submit").click();
  // Wait for todo 1 to actually land before starting todo 2: BoardCard's
  // `addTodo()` clears the title/description fields only AFTER its
  // `await kanban.createTodo(...)` resolves. Filling todo 2's title while
  // that's still in flight races the clear — if createTodo() takes long
  // enough (a real possibility under load, not a bug in itself), the clear
  // fires after the fill and wipes it back to empty, permanently disabling
  // "create-todo-submit" (empty title, not a stuck busy flag — confirmed by
  // reproducing this directly and reading the input's DOM value at the hang).
  await expect(todoItem(pageA, "Cascade todo 1")).toBeVisible();
  await cardA.getByTestId("todo-title-input").fill("Cascade todo 2");
  await cardA.getByTestId("create-todo-submit").click();
  await expect(todoItem(pageA, "Cascade todo 2")).toBeVisible();

  await syncNow(pageA);
  await syncNow(pageB);
  await expect(boardCard(pageB, boardName)).toBeVisible();
  await expect(todoItem(pageB, "Cascade todo 1")).toBeVisible();
  await expect(todoItem(pageB, "Cascade todo 2")).toBeVisible();

  await cardA.getByTestId("delete-board").click();
  await expect(cardA).not.toBeVisible();

  await syncNow(pageA);
  await syncNow(pageB);

  await expect(boardCard(pageB, boardName)).not.toBeVisible();
  await expect(todoItem(pageB, "Cascade todo 1")).not.toBeVisible();
  await expect(todoItem(pageB, "Cascade todo 2")).not.toBeVisible();
});

test("a board created while offline syncs once the device reconnects", async ({ devices }) => {
  const [pageA, pageB] = devices;
  const boardName = `Offline Board ${Date.now()}`;

  await pageA.context().setOffline(true);
  await createBoard(pageA, boardName);
  // Written locally, nothing pushed yet.
  await expect(pageA.getByTestId("sync-pending-count")).toHaveText("1");

  await pageA.context().setOffline(false);
  await syncNow(pageA);
  await syncNow(pageB);

  await expect(boardCard(pageB, boardName)).toBeVisible();
});

test("concurrent updates to the same board — the later push wins", async ({ devices }) => {
  const [pageA, pageB] = devices;
  const boardName = `Conflict Board ${Date.now()}`;

  await createBoard(pageA, boardName);
  await syncNow(pageA);
  await syncNow(pageB);
  await expect(boardCard(pageB, boardName)).toBeVisible();

  // Both devices edit the same board, each unaware of the other's change —
  // a genuine conflict, not a sequential edit.
  await boardCard(pageA, boardName).getByTestId("board-name-field").fill("Version A");
  await boardCard(pageA, boardName).getByTestId("save-board").click();
  await boardCard(pageB, boardName).getByTestId("board-name-field").fill("Version B");
  await boardCard(pageB, boardName).getByTestId("save-board").click();

  // A pushes first, then B — B's changelog entry lands later server-side.
  await syncNow(pageA);
  await syncNow(pageB);
  await syncNow(pageA);

  await expect(boardCard(pageA, "Version B")).toBeVisible();
  await expect(boardCard(pageA, "Version A")).not.toBeVisible();
});

/**
 * The counterpart to the LWW test above, for a delete/update conflict
 * instead of update/update. This app's push protocol carries a partial
 * patch for updates (`{ patch, key }`), not a full row snapshot — unlike
 * the older prisma-idb generator, whose outbox always carried the complete
 * record and could `upsert` a deleted row back into existence ("last
 * writer" symmetrically wins for any operation type, including update-after-
 * delete "resurrecting" a record). A partial patch alone can't reconstruct a
 * valid row (missing e.g. `userId`/`createdAt`), so here a delete is
 * final: an update pushed after it fails authorization (its `startRow`
 * lookup finds nothing) instead of resurrecting the record, and the device
 * that made the now-orphaned edit self-corrects on its next pull. Documents
 * this app's actual (delete-always-wins) behavior, not a design goal.
 */
test("a delete beats a concurrent update — no resurrection in this app's current design", async ({ devices }) => {
  const [pageA, pageB] = devices;
  const boardName = `Delete Wins Board ${Date.now()}`;

  await createBoard(pageA, boardName);
  await syncNow(pageA);
  await syncNow(pageB);
  await expect(boardCard(pageB, boardName)).toBeVisible();

  // Device A edits the board (not yet synced)...
  await boardCard(pageA, boardName).getByTestId("board-name-field").fill("Edited before delete");
  await boardCard(pageA, boardName).getByTestId("save-board").click();

  // ...while device B deletes it — also not yet synced.
  await boardCard(pageB, boardName).getByTestId("delete-board").click();
  await expect(boardCard(pageB, boardName)).not.toBeVisible();

  // B's delete reaches the server first.
  await syncNow(pageB);
  // A's update is pushed second, against a board that's already gone.
  await syncNow(pageA);
  // One more cycle so A is guaranteed to have pulled B's delete changelog
  // entry (belt-and-suspenders against the two network round trips landing
  // in the same cycle vs. needing a second one).
  await syncNow(pageA);

  await expect(boardCard(pageA, "Edited before delete")).not.toBeVisible();
  await expect(boardCard(pageA, boardName)).not.toBeVisible();
});
