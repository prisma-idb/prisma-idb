import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * Real-browser multi-tab sync test, via /test-sync-harness (never linked
 * from app navigation — see that route for why this needs a real browser:
 * fake-indexeddb is a single JS process and can't model two independent
 * tabs racing transactions against the same origin's IndexedDB the way a
 * real browser's cross-connection transaction serialization does).
 *
 * There is currently no cross-tab coordination (no BroadcastChannel/leader
 * election) in sync-extension-idb — this test proves what actually happens
 * today when two tabs run independent SyncWorkers against the same outbox,
 * rather than assuming either "it's fine" or "it's broken".
 */

async function gotoHarness(page: Page, dbName: string): Promise<void> {
  await page.goto(`/test-sync-harness?db=${dbName}`);
  await expect(page.getByText("sync-harness-ready")).toBeVisible({ timeout: 15_000 });
}

/** Installs a SyncWorker on `window.__worker` with a delayed pushHandler that records which event ids it was asked to push, on `window.__pushed`. */
async function installDelayedWorker(page: Page, delayMs: number): Promise<void> {
  await page.evaluate((delay) => {
    const w = window as unknown as {
      __syncHarness: { syncClient: { createSyncWorker: (opts: unknown) => unknown } };
      __pushed: string[];
      __worker: { forceSync: () => Promise<void> };
    };
    w.__pushed = [];
    w.__worker = w.__syncHarness.syncClient.createSyncWorker({
      pushHandler: async (events: { id: string }[]) => {
        w.__pushed.push(...events.map((e) => e.id));
        await new Promise((resolve) => setTimeout(resolve, delay));
        return events.map((e) => ({ id: e.id, success: true }));
      },
      pullHandler: async () => [],
    }) as { forceSync: () => Promise<void> };
  }, delayMs);
}

test("two tabs racing SyncWorker.forceSync() against the same outbox — documents current (no cross-tab lock) behavior", async ({
  browser,
}) => {
  const dbName = `sync-multi-tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const context = await browser.newContext();
  const tabA = await context.newPage();
  const tabB = await context.newPage();

  await gotoHarness(tabA, dbName);
  await gotoHarness(tabB, dbName);

  // One tracked write from tab A — one outbox event to race over.
  await tabA.evaluate(async () => {
    const w = window as unknown as {
      __syncHarness: { syncClient: { orm: Record<string, { create: (data: unknown) => Promise<unknown> }> } };
    };
    await w.__syncHarness.syncClient.orm["user"]!.create({ id: "u1", name: "Alice" });
  });

  // A generous delay widens the race window so the outcome isn't flaky —
  // both tabs' getNextBatch() reads should land before either's markSynced()
  // commits, which is the scenario that actually risks a duplicate push.
  await installDelayedWorker(tabA, 500);
  await installDelayedWorker(tabB, 500);

  await Promise.all([
    tabA.evaluate(() => (window as unknown as { __worker: { forceSync: () => Promise<void> } }).__worker.forceSync()),
    tabB.evaluate(() => (window as unknown as { __worker: { forceSync: () => Promise<void> } }).__worker.forceSync()),
  ]);

  const pushedA = await tabA.evaluate(() => (window as unknown as { __pushed: string[] }).__pushed);
  const pushedB = await tabB.evaluate(() => (window as unknown as { __pushed: string[] }).__pushed);

  // Regardless of whether the race actually double-pushed this run, local
  // IDB state must stay consistent: exactly one user row, and the outbox
  // event ends up marked synced (not corrupted by two concurrent writers).
  const finalState = await tabA.evaluate(async () => {
    const w = window as unknown as {
      __syncHarness: {
        syncClient: { withTransaction: (stores: string[], fn: (scope: unknown) => unknown) => unknown };
      };
    };
    const users = (await w.__syncHarness.syncClient.withTransaction(["user"], async (scope) => {
      return (scope as { execute: (plan: unknown) => Promise<unknown[]> }).execute({
        kind: "cursor-scan",
        storeName: "user",
      });
    })) as unknown[];
    const outbox = (await w.__syncHarness.syncClient.withTransaction(["_idb_sync_outbox"], async (scope) => {
      return (scope as { execute: (plan: unknown) => Promise<unknown[]> }).execute({
        kind: "cursor-scan",
        storeName: "_idb_sync_outbox",
      });
    })) as unknown[];
    return { users, outbox };
  });

  expect(finalState.users).toHaveLength(1);
  expect(finalState.outbox).toHaveLength(1);
  expect((finalState.outbox[0] as { synced: boolean }).synced).toBe(true);

  // Document what actually happened with the push race this run, rather
  // than asserting a specific outcome either way — see the module doc
  // comment. Total push attempts across both tabs for the one event:
  // 1 = no overlap this run, 2 = both tabs saw + pushed it (the risk this
  // test exists to surface).
  const allPushed = [...pushedA, ...pushedB];
  const totalPushAttempts = allPushed.length;
  expect(totalPushAttempts).toBeGreaterThanOrEqual(1);
  // sanity: no unrelated events — checked across both tabs combined so this
  // can't pass vacuously when one tab pushed nothing.
  expect(allPushed.every((id) => id === allPushed[0])).toBe(true);
  if (totalPushAttempts > 1) {
    console.log(
      `[sync-multi-tab] Duplicate push observed this run: tab A pushed ${pushedA.length}, tab B pushed ${pushedB.length} — no cross-tab lock exists yet.`
    );
  }
});
