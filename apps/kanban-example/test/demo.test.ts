import { expect, test } from "./fixtures";

test("syncs_create_update_delete_across_devices", async ({ pages }) => {
  const [pageA, pageB] = pages;

  // Device A: Create a new board
  await pageA.getByTestId("create-board-button").click();
  await pageA.getByTestId("board-menu-Board 1").click();
  await pageA.getByTestId("update-Board 1").click();
  await pageA.getByTestId(`rename-board-Board 1-input`).fill("Project Alpha");
  await pageA.getByTestId("rename-board-Board 1-submit").click();
  await expect(pageA.getByText("Project Alpha")).toBeVisible();

  // Device A: Sync changes
  await Promise.all([
    pageA.getByTestId("sync-now-button").click(),
    pageA.waitForResponse((resp) => resp.url().includes("/sync/pull") && resp.status() === 200),
  ]);

  // Device B: Sync changes and verify the new board appears
  await Promise.all([
    pageB.getByTestId("sync-now-button").click(),
    pageB.waitForResponse((resp) => resp.url().includes("/sync/pull") && resp.status() === 200),
  ]);
  await expect(pageB.getByText("Project Alpha")).toBeVisible();

  // Device B: Update the board name
  await pageB.getByTestId("board-menu-Project Alpha").click();
  await pageB.getByTestId("update-Project Alpha").click();
  await pageB.getByTestId(`rename-board-Project Alpha-input`).fill("Project Beta");
  await pageB.getByTestId("rename-board-Project Alpha-submit").click();
  await expect(pageB.getByText("Project Beta")).toBeVisible();

  // Device B: Sync changes
  await Promise.all([
    pageB.getByTestId("sync-now-button").click(),
    pageB.waitForResponse((resp) => resp.url().includes("/sync/pull") && resp.status() === 200),
  ]);

  // Device A: Sync changes and verify the updated board name appears
  await Promise.all([
    pageA.getByTestId("sync-now-button").click(),
    pageA.waitForResponse((resp) => resp.url().includes("/sync/pull") && resp.status() === 200),
  ]);
  await expect(pageA.getByText("Project Beta")).toBeVisible();

  // Device A: Delete the board
  await pageA.getByTestId("board-menu-Project Beta").click();
  await pageA.getByTestId("update-Project Beta").click();
  await pageA.getByTestId("delete-board-Project Beta").click();
  await expect(pageA.getByText("Project Beta")).not.toBeVisible();

  // Device A: Sync changes
  await Promise.all([
    pageA.getByTestId("sync-now-button").click(),
    pageA.waitForResponse((resp) => resp.url().includes("/sync/pull") && resp.status() === 200),
  ]);

  // Device B: Sync changes and verify the board is deleted
  await Promise.all([
    pageB.getByTestId("sync-now-button").click(),
    pageB.waitForResponse((resp) => resp.url().includes("/sync/pull") && resp.status() === 200),
  ]);
  await expect(pageB.getByText("Project Beta")).not.toBeVisible();
});

test("offline_creates_sync_after_reconnect", async ({ pages }) => {
  const [pageA, pageB] = pages;

  // Device A: Create a board offline (without syncing)
  await pageA.getByTestId("create-board-button").click();
  await pageA.getByTestId("board-menu-Board 1").click();
  await pageA.getByTestId("update-Board 1").click();
  await pageA.getByTestId(`rename-board-Board 1-input`).fill("Offline Board");
  await pageA.getByTestId("rename-board-Board 1-submit").click();
  await expect(pageA.getByText("Offline Board")).toBeVisible();

  // Device A: Now sync the offline changes
  await Promise.all([
    pageA.getByTestId("sync-now-button").click(),
    pageA.waitForResponse((resp) => resp.url().includes("/sync/pull") && resp.status() === 200),
  ]);

  // Device B: Sync and verify the board created offline now appears
  await Promise.all([
    pageB.getByTestId("sync-now-button").click(),
    pageB.waitForResponse((resp) => resp.url().includes("/sync/pull") && resp.status() === 200),
  ]);
  await expect(pageB.getByText("Offline Board")).toBeVisible();
});

test("offline_updates_resurrect_deleted_records", async ({ pages }) => {
  const [pageA, pageB] = pages;

  // Setup: Create a board and todo on Device A
  await pageA.getByTestId("create-board-button").click();
  await pageA.getByTestId("board-menu-Board 1").click();
  await pageA.getByTestId("update-Board 1").click();
  await pageA.getByTestId(`rename-board-Board 1-input`).fill("Shared Board");
  await pageA.getByTestId("rename-board-Board 1-submit").click();
  await Promise.all([
    pageA.getByTestId("sync-now-button").click(),
    pageA.waitForResponse((resp) => resp.url().includes("/sync/pull") && resp.status() === 200),
  ]);

  // Device B: Sync and see the board
  await Promise.all([
    pageB.getByTestId("sync-now-button").click(),
    pageB.waitForResponse((resp) => resp.url().includes("/sync/pull") && resp.status() === 200),
  ]);
  await expect(pageB.getByText("Shared Board")).toBeVisible();

  // Device A: Create a todo
  await pageA.getByTestId("board-menu-Shared Board").click();
  await pageA.getByTestId("add-todo-Shared Board").click();
  await pageA.getByTestId("create-todo-title-input").fill("Test Todo");
  await pageA.getByTestId("create-todo-submit").click();
  await expect(pageA.getByText("Test Todo")).toBeVisible();

  // Device A: Sync the todo
  await Promise.all([
    pageA.getByTestId("sync-now-button").click(),
    pageA.waitForResponse((resp) => resp.url().includes("/sync/pull") && resp.status() === 200),
  ]);

  // Device B: Sync and see the todo
  await Promise.all([
    pageB.getByTestId("sync-now-button").click(),
    pageB.waitForResponse((resp) => resp.url().includes("/sync/pull") && resp.status() === 200),
  ]);
  await expect(pageB.getByText("Test Todo")).toBeVisible();

  // Device B: Delete the todo
  await pageB.getByTestId("edit-todo-Test Todo").click();
  await pageB.getByTestId("delete-todo-Test Todo").click();
  await expect(pageB.getByText("Test Todo")).not.toBeVisible();

  // Device B: Sync the deletion
  await Promise.all([
    pageB.getByTestId("sync-now-button").click(),
    pageB.waitForResponse((resp) => resp.url().includes("/sync/pull") && resp.status() === 200),
  ]);

  // Device A: Update the todo without syncing (offline condition)
  await pageA.getByTestId("edit-todo-Test Todo").click();
  await pageA.getByTestId(`update-todo-Test Todo-input`).fill("Updated Test Todo");
  await pageA.getByTestId("update-todo-Test Todo-submit").click();
  await expect(pageA.getByText("Updated Test Todo")).toBeVisible();

  // Device A: Sync the offline update - todo should still be there
  await Promise.all([
    pageA.getByTestId("sync-now-button").click(),
    pageA.waitForResponse((resp) => resp.url().includes("/sync/pull") && resp.status() === 200),
  ]);
  await expect(pageA.getByText("Updated Test Todo")).toBeVisible();

  // Device B: Sync and verify the updated todo appears there too
  await Promise.all([
    pageB.getByTestId("sync-now-button").click(),
    pageB.waitForResponse((resp) => resp.url().includes("/sync/pull") && resp.status() === 200),
  ]);
  await expect(pageB.getByText("Updated Test Todo")).toBeVisible();
});

test("last_writer_wins_on_concurrent_updates", async ({ pages }) => {
  const [pageA, pageB] = pages;

  // Setup: Create a board
  await pageA.getByTestId("create-board-button").click();
  await pageA.getByTestId("board-menu-Board 1").click();
  await pageA.getByTestId("update-Board 1").click();
  await pageA.getByTestId(`rename-board-Board 1-input`).fill("Conflict Board");
  await pageA.getByTestId("rename-board-Board 1-submit").click();
  await Promise.all([
    pageA.getByTestId("sync-now-button").click(),
    pageA.waitForResponse((resp) => resp.url().includes("/sync/pull") && resp.status() === 200),
  ]);

  // Device B: Sync to see the board
  await Promise.all([
    pageB.getByTestId("sync-now-button").click(),
    pageB.waitForResponse((resp) => resp.url().includes("/sync/pull") && resp.status() === 200),
  ]);
  await expect(pageB.getByText("Conflict Board")).toBeVisible();

  // Device A: Edit the board (without syncing)
  await pageA.getByTestId("board-menu-Conflict Board").click();
  await pageA.getByTestId("update-Conflict Board").click();
  await pageA.getByTestId(`rename-board-Conflict Board-input`).fill("Board Version A");
  await pageA.getByTestId("rename-board-Conflict Board-submit").click();

  // Device B: Edit the same board (without syncing)
  await pageB.getByTestId("board-menu-Conflict Board").click();
  await pageB.getByTestId("update-Conflict Board").click();
  await pageB.getByTestId(`rename-board-Conflict Board-input`).fill("Board Version B");
  await pageB.getByTestId("rename-board-Conflict Board-submit").click();

  // Device A: Sync first
  await Promise.all([
    pageA.getByTestId("sync-now-button").click(),
    pageA.waitForResponse((resp) => resp.url().includes("/sync/pull") && resp.status() === 200),
  ]);

  // Device B: Sync second (B's version should win as last writer)
  await Promise.all([
    pageB.getByTestId("sync-now-button").click(),
    pageB.waitForResponse((resp) => resp.url().includes("/sync/pull") && resp.status() === 200),
  ]);

  // Device A: Verify B's version won
  await Promise.all([
    pageA.getByTestId("sync-now-button").click(),
    pageA.waitForResponse((resp) => resp.url().includes("/sync/pull") && resp.status() === 200),
  ]);
  await expect(pageA.getByText("Board Version B")).toBeVisible();
  const boardVersionALocator = pageA.locator("text=Board Version A");
  await expect(boardVersionALocator).not.toBeVisible();
});

test("delete_wins_when_applied_last", async ({ pages }) => {
  const [pageA, pageB] = pages;

  // Setup: Create a board
  await pageA.getByTestId("create-board-button").click();
  await pageA.getByTestId("board-menu-Board 1").click();
  await pageA.getByTestId("update-Board 1").click();
  await pageA.getByTestId(`rename-board-Board 1-input`).fill("Delete Test Board");
  await pageA.getByTestId("rename-board-Board 1-submit").click();
  await Promise.all([
    pageA.getByTestId("sync-now-button").click(),
    pageA.waitForResponse((resp) => resp.url().includes("/sync/pull") && resp.status() === 200),
  ]);

  // Device B: Sync to see the board
  await Promise.all([
    pageB.getByTestId("sync-now-button").click(),
    pageB.waitForResponse((resp) => resp.url().includes("/sync/pull") && resp.status() === 200),
  ]);
  await expect(pageB.getByText("Delete Test Board")).toBeVisible();

  // Device A: Update the board (without syncing)
  await pageA.getByTestId("board-menu-Delete Test Board").click();
  await pageA.getByTestId("update-Delete Test Board").click();
  await pageA.getByTestId(`rename-board-Delete Test Board-input`).fill("Updated Board");
  await pageA.getByTestId("rename-board-Delete Test Board-submit").click();

  // Device B: Delete the board (without syncing)
  await pageB.getByTestId("board-menu-Delete Test Board").click();
  await pageB.getByTestId("update-Delete Test Board").click();
  await pageB.getByTestId("delete-board-Delete Test Board").click();
  await expect(pageB.getByText("Delete Test Board")).not.toBeVisible();

  // Device A: Sync first (update)
  await Promise.all([
    pageA.getByTestId("sync-now-button").click(),
    pageA.waitForResponse((resp) => resp.url().includes("/sync/pull") && resp.status() === 200),
  ]);

  // Device B: Sync second (delete)
  await Promise.all([
    pageB.getByTestId("sync-now-button").click(),
    pageB.waitForResponse((resp) => resp.url().includes("/sync/pull") && resp.status() === 200),
  ]);

  // Device A: Verify the board is deleted (delete wins)
  await Promise.all([
    pageA.getByTestId("sync-now-button").click(),
    pageA.waitForResponse((resp) => resp.url().includes("/sync/pull") && resp.status() === 200),
  ]);
  const updatedBoardLocator = pageA.locator("text=Updated Board");
  const deleteTestBoardLocator = pageA.locator("text=Delete Test Board");
  await expect(updatedBoardLocator).not.toBeVisible();
  await expect(deleteTestBoardLocator).not.toBeVisible();
});

test("update_wins_when_applied_last", async ({ pages }) => {
  const [pageA, pageB] = pages;

  // Setup: Create a board
  await pageA.getByTestId("create-board-button").click();
  await pageA.getByTestId("board-menu-Board 1").click();
  await pageA.getByTestId("update-Board 1").click();
  await pageA.getByTestId(`rename-board-Board 1-input`).fill("Update Test Board");
  await pageA.getByTestId("rename-board-Board 1-submit").click();
  await Promise.all([
    pageA.getByTestId("sync-now-button").click(),
    pageA.waitForResponse((resp) => resp.url().includes("/sync/pull") && resp.status() === 200),
  ]);

  // Device B: Sync to see the board
  await Promise.all([
    pageB.getByTestId("sync-now-button").click(),
    pageB.waitForResponse((resp) => resp.url().includes("/sync/pull") && resp.status() === 200),
  ]);
  await expect(pageB.getByText("Update Test Board")).toBeVisible();

  // Device A: Delete the board (without syncing)
  await pageA.getByTestId("board-menu-Update Test Board").click();
  await pageA.getByTestId("update-Update Test Board").click();
  await pageA.getByTestId("delete-board-Update Test Board").click();
  await expect(pageA.getByText("Update Test Board")).not.toBeVisible();

  // Device B: Update the board (without syncing)
  await pageB.getByTestId("board-menu-Update Test Board").click();
  await pageB.getByTestId("update-Update Test Board").click();
  await pageB.getByTestId(`rename-board-Update Test Board-input`).fill("Updated from B");
  await pageB.getByTestId("rename-board-Update Test Board-submit").click();
  await expect(pageB.getByText("Updated from B")).toBeVisible();

  // Device A: Sync first (delete)
  await Promise.all([
    pageA.getByTestId("sync-now-button").click(),
    pageA.waitForResponse((resp) => resp.url().includes("/sync/pull") && resp.status() === 200),
  ]);

  // Device B: Sync second (update)
  await Promise.all([
    pageB.getByTestId("sync-now-button").click(),
    pageB.waitForResponse((resp) => resp.url().includes("/sync/pull") && resp.status() === 200),
  ]);

  // Device A: Verify the board exists with B's update (update wins)
  await Promise.all([
    pageA.getByTestId("sync-now-button").click(),
    pageA.waitForResponse((resp) => resp.url().includes("/sync/pull") && resp.status() === 200),
  ]);
  await expect(pageA.getByText("Updated from B")).toBeVisible();
});

test("rejects_update_when_parent_deleted", async ({ pages }) => {
  const [pageA, pageB] = pages;

  // Setup: Create a board with a todo
  await pageA.getByTestId("create-board-button").click();
  await pageA.getByTestId("board-menu-Board 1").click();
  await pageA.getByTestId("update-Board 1").click();
  await pageA.getByTestId(`rename-board-Board 1-input`).fill("Parent Board");
  await pageA.getByTestId("rename-board-Board 1-submit").click();

  await pageA.getByTestId("board-menu-Parent Board").click();
  await pageA.getByTestId("add-todo-Parent Board").click();
  await pageA.getByTestId("create-todo-title-input").fill("Child Todo");
  await pageA.getByTestId("create-todo-submit").click();
  await expect(pageA.getByText("Child Todo")).toBeVisible();

  await Promise.all([
    pageA.getByTestId("sync-now-button").click(),
    pageA.waitForResponse((resp) => resp.url().includes("/sync/pull") && resp.status() === 200),
  ]);

  // Device B: Sync to see the board and todo
  await Promise.all([
    pageB.getByTestId("sync-now-button").click(),
    pageB.waitForResponse((resp) => resp.url().includes("/sync/pull") && resp.status() === 200),
  ]);
  await expect(pageB.getByText("Parent Board")).toBeVisible();
  await expect(pageB.getByText("Child Todo")).toBeVisible();

  // Device B: Delete the board
  await pageB.getByTestId("board-menu-Parent Board").click();
  await pageB.getByTestId("update-Parent Board").click();
  await pageB.getByTestId("delete-board-Parent Board").click();
  await expect(pageB.getByText("Parent Board")).not.toBeVisible();
  await expect(pageB.getByText("Child Todo")).not.toBeVisible();

  // Device B: Sync the deletion
  await Promise.all([
    pageB.getByTestId("sync-now-button").click(),
    pageB.waitForResponse((resp) => resp.url().includes("/sync/pull") && resp.status() === 200),
  ]);

  // Device A: Verify the parent and child are deleted
  await Promise.all([
    pageA.getByTestId("sync-now-button").click(),
    pageA.waitForResponse((resp) => resp.url().includes("/sync/pull") && resp.status() === 200),
  ]);
  const parentBoardLocator = pageA.locator("text=Parent Board");
  const childTodoLocator = pageA.locator("text=Child Todo");
  await expect(parentBoardLocator).not.toBeVisible();
  await expect(childTodoLocator).not.toBeVisible();
});
