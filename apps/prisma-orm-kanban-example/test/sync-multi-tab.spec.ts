import { expect, test, type Page } from "@playwright/test";
import type { Contract } from "../src/lib/prisma/contract";
import { signInAsTestUser } from "./test-utils-signin";
import type { SyncIdbClient, SyncWorker } from "@prisma-idb/sync-extension-idb/client";

/** The test harness exposes a client and a worker in each independent tab. */
type HarnessWindow = Window & {
  __syncHarness: { syncClient: SyncIdbClient<Contract> };
  awaitPeer: () => Promise<void>;
  worker: SyncWorker;
};

/** Opens another connection to the same real browser database. */
async function gotoHarness(page: Page, dbName: string): Promise<void> {
  await page.goto(`/test-sync-harness?db=${dbName}`);
  await expect(page.getByText("sync-harness-ready")).toBeVisible({ timeout: 15_000 });
}

/** Holds delivery until both workers have read the outbox, then sends real HTTP pushes. */
async function installWorker(page: Page, awaitPeer: () => Promise<void>): Promise<void> {
  await page.exposeFunction("awaitPeer", awaitPeer);
  await page.evaluate(() => {
    const w = window as unknown as HarnessWindow;
    w.worker = w.__syncHarness.syncClient.createSyncWorker({
      pushHandler: async (events, _signal, context) => {
        await w.awaitPeer();
        const response = await fetch("/api/sync/push", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ storageHash: context.storageHash, events }),
        });
        if (!response.ok) throw new Error(`Push failed: ${response.status}`);
        return response.json();
      },
      pullHandler: async () => [],
    });
  });
}

/** Mirrors the signed-in user without queuing it, then queues one board mutation. */
async function seedBoard(page: Page, userId: string, boardId: string): Promise<void> {
  await page.evaluate(
    async ({ userId, boardId }) => {
      const client = (window as unknown as HarnessWindow).__syncHarness.syncClient;
      await client.withoutTracking((orm) =>
        orm.user.create({
          id: userId,
          name: "Alice",
          email: `${userId}@example.com`,
          emailVerified: false,
          image: null,
          isAnonymous: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
      );
      await client.orm.board.create({
        id: boardId,
        name: "Shared",
        userId,
        createdAt: new Date(),
      });
    },
    { userId, boardId }
  );
}

/** Reads the committed rows shared by both tab connections. */
async function readLocalState(page: Page) {
  return page.evaluate(async () => {
    const client = (window as unknown as HarnessWindow).__syncHarness.syncClient;
    return client.withTransaction(["board", "_idb_sync_outbox"], async (scope) => ({
      boards: await scope.execute({ kind: "cursor-scan", storeName: "board" } as never),
      outbox: await scope.execute({ kind: "cursor-scan", storeName: "_idb_sync_outbox" } as never),
    }));
  });
}

/** Uses the browser's authenticated cookie to read changes through the public HTTP route. */
async function pullChanges(page: Page) {
  return page.evaluate(async () => {
    const hash = (window as unknown as HarnessWindow).__syncHarness.syncClient.contract.storage.storageHash;
    const response = await fetch(`/api/sync/pull?${new URLSearchParams({ storageHash: hash })}`);
    return { status: response.status, logs: await response.json() };
  });
}

test("two tabs delivering one outbox event leave one server change and a synced local row", async ({ browser }) => {
  const dbName = `sync-multi-tab-${crypto.randomUUID()}`;
  const context = await browser.newContext();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let ready = 0;
  /** Forces duplicate delivery without depending on machine speed or a sleep. */
  async function awaitPeer() {
    if (++ready === 2) release();
    await gate;
  }
  try {
    const tabA = await context.newPage();
    const tabB = await context.newPage();
    const user = await signInAsTestUser(tabA);
    await gotoHarness(tabA, dbName);
    await gotoHarness(tabB, dbName);
    const boardId = crypto.randomUUID();
    await seedBoard(tabA, user.id, boardId);
    await installWorker(tabA, awaitPeer);
    await installWorker(tabB, awaitPeer);
    await Promise.all(
      [tabA, tabB].map((page) => page.evaluate(() => (window as unknown as HarnessWindow).worker.forceSync()))
    );

    const local = await readLocalState(tabA);
    expect(local.boards).toMatchObject([{ id: boardId, name: "Shared" }]);
    expect(local.boards).toHaveLength(1);
    expect(local.outbox).toMatchObject([{ synced: true }]);
    expect(local.outbox).toHaveLength(1);
    const { status, logs } = await pullChanges(tabA);
    expect(status).toBe(200);
    expect(logs).toMatchObject([{ model: "Board", keyPath: boardId, record: { id: boardId, name: "Shared" } }]);
    expect(logs).toHaveLength(1);
  } finally {
    release();
    await context.close();
  }
});
