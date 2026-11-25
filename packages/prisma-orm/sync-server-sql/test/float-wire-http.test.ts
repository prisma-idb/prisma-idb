import { expect, it } from "vitest";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import idbFamily from "@prisma-idb/family-idb/pack";
import idbTarget from "@prisma-idb/target-idb/pack";
import { decodeJsonRecord, encodeJsonRecord, validateRecord } from "@prisma-idb/target-idb/runtime";
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

it("round-trips both infinite Float keys and list elements through PostgreSQL HTTP sync", async () => {
  const db = await testDb();
  await seed(db, { User: [{ id: "u1", name: "Owner" }] });
  const contract = defineContract({
    family: idbFamily,
    target: idbTarget,
    models: {
      FloatItem: { store: "floatItems", key: "id", fields: { id: "Float", ownerId: "String", readings: "Float[]" } },
    },
  });
  const records = [
    { id: Infinity, ownerId: "u1", readings: [-Infinity, 1.5, Infinity] },
    { id: -Infinity, ownerId: "u1", readings: [Infinity, -1.5, -Infinity] },
  ];
  const events = records.map((record, index) => ({
    id: `float-${index}`,
    entityType: "FloatItem",
    operation: "create",
    payload: encodeJsonRecord(contract, "FloatItem", record),
  }));
  const pushed = await handlers.push(
    new Request("https://sync.test/push", {
      method: "POST",
      body: JSON.stringify({ storageHash, events }),
    })
  );
  expect(pushed.status).toBe(200);
  expect(await pushed.json()).toEqual([
    { id: "float-0", success: true },
    { id: "float-1", success: true },
  ]);
  for (const [index, record] of records.entries()) {
    expect(await ormRootFor(db, "FloatItem").first({ id: record.id })).toEqual(record);
    expect(await ormRootFor(db, "Changelog").first({ outboxEventId: `float-${index}` })).toMatchObject({
      keyPath: String(record.id),
    });
  }

  const pulled = await handlers.pull(new Request(`https://sync.test/pull?storageHash=${storageHash}`));
  expect(pulled.status).toBe(200);
  const { logs, hasMore } = (await pulled.json()) as {
    logs: { keyPath: string; record: Record<string, unknown> }[];
    hasMore: boolean;
  };
  expect(hasMore).toBe(false);
  expect(logs.map((log) => ({ keyPath: log.keyPath, record: log.record }))).toEqual([
    { keyPath: "Infinity", record: events[0]!.payload },
    { keyPath: "-Infinity", record: events[1]!.payload },
  ]);
  const decoded = logs.map((log) => decodeJsonRecord(contract, "FloatItem", log.record));
  expect(decoded).toEqual(records);
  for (const record of decoded) expect(validateRecord(contract, "FloatItem", record)).toEqual({ ok: true });
});
