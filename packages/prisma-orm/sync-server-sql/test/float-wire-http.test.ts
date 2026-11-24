import { expect, it } from "vitest";
import { createSqlSync } from "../src/exports/index";
import { ormRootFor } from "../src/core/orm-root";
import { seed, testClientContract, testContract, testDb, testSyncServer } from "./helpers";

const handlers = createSqlSync({
  contract: testContract,
  clientContract: testClientContract,
  rootModel: "User",
  db: testDb,
  scopeKey: "u1",
});
const storageHash = testSyncServer.clientStorageHash;

it("refuses an overflowing JSON Float key without writing a row or changelog entry", async () => {
  const db = await testDb();
  await seed(db, { User: [{ id: "u1", name: "Owner" }] });
  const payload = '{"id":1e309,"ownerId":"u1","readings":[]}';
  const response = await handlers.push(
    new Request("https://sync.test/push", {
      method: "POST",
      body: `{"storageHash":${JSON.stringify(storageHash)},"events":[{"id":"overflow","entityType":"FloatItem","operation":"create","payload":${payload}}]}`,
    })
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toStrictEqual([
    { id: "overflow", success: false, error: "KEYPATH_VALIDATION_FAILURE", retryable: false },
  ]);
  expect(await ormRootFor(db, "FloatItem").first({ ownerId: "u1" })).toBeNull();
  expect(await ormRootFor(db, "Changelog").first({ outboxEventId: "overflow" })).toBeNull();
  const pulled = await handlers.pull(new Request(`https://sync.test/pull?storageHash=${storageHash}`));
  expect(pulled.status).toBe(200);
  expect(await pulled.json()).toEqual({ logs: [], hasMore: false });
});
