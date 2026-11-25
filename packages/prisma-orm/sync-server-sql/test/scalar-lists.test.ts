import { expect, it } from "vitest";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import idbFamily from "@prisma-idb/family-idb/pack";
import idbTarget from "@prisma-idb/target-idb/pack";
import { decodeJsonRecord, validateRecord } from "@prisma-idb/target-idb/runtime";
import { createSqlSync } from "../src/exports/index";
import { ormRootFor } from "../src/core/orm-root";
import { testClientContract, testContract, testDb, testSyncServer, seed } from "./helpers";

const clientContract = defineContract({
  family: idbFamily,
  target: idbTarget,
  models: {
    ListItem: {
      store: "listItems",
      key: "id",
      fields: {
        id: "String",
        ownerId: "String",
        tags: "String[]",
        stamp: "DateTime",
        dates: "DateTime[]",
        bigs: "BigInt[]",
        bytes: "Bytes[]",
        decimals: "Decimal[]",
        jsons: "Json[]",
      },
    },
  },
});

it("round-trips scalar-list codecs through Postgres HTTP push, pull and rejected records", async () => {
  const db = await testDb();
  await seed(db, { User: [{ id: "u1", name: "Owner" }] });
  const handlers = createSqlSync({
    contract: testContract,
    clientContract: testClientContract,
    rootModel: "User",
    db,
    scopeKey: "u1",
  });
  const storageHash = testSyncServer.clientStorageHash;
  const push = (events: unknown[]) =>
    handlers.push(
      new Request("https://sync.test/push", {
        method: "POST",
        body: JSON.stringify({ storageHash, events }),
      })
    );
  const wire = {
    id: "list-1",
    ownerId: "u1",
    tags: ["a"],
    stamp: "2026-02-03T04:05:06.000Z",
    dates: ["2026-01-02T03:04:05.000Z"],
    bigs: ["42"],
    bytes: ["AQI="],
    decimals: ["1.25"],
    jsons: [{ nested: [true] }],
  };
  const native = {
    ...wire,
    stamp: new Date(wire.stamp),
    dates: [new Date(wire.dates[0]!)],
    bigs: [42n],
    bytes: [new Uint8Array([1, 2])],
  };
  const pushed = await push([{ id: "list-create", entityType: "ListItem", operation: "create", payload: wire }]);
  expect(pushed.status).toBe(200);
  expect(await pushed.json()).toEqual([{ id: "list-create", success: true }]);
  expect(await ormRootFor(db, "ListItem").first({ id: "list-1" })).toEqual(native);

  const pulled = await handlers.pull(new Request(`https://sync.test/pull?storageHash=${storageHash}`));
  expect(pulled.status).toBe(200);
  const { logs } = (await pulled.json()) as { logs: { model: string; record: Record<string, unknown> }[] };
  const record = logs.find((log) => log.model === "ListItem")!.record;
  expect(record).toEqual(wire);
  const decoded = decodeJsonRecord(clientContract, "ListItem", record);
  expect(decoded).toEqual(native);
  expect(validateRecord(clientContract, "ListItem", decoded)).toEqual({ ok: true });

  const rejected = await push([
    { id: "move", entityType: "ListItem", operation: "update", payload: { key: "list-1", patch: { ownerId: "u2" } } },
  ]);
  expect(rejected.status).toBe(200);
  expect(await rejected.json()).toEqual([
    { id: "move", success: false, error: "SCOPE_VIOLATION", retryable: false, record: wire },
  ]);
});
