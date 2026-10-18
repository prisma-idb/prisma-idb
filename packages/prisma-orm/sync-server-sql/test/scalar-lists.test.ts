import { expect, it } from "vitest";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import idbFamily from "@prisma-idb/family-idb/pack";
import idbTarget from "@prisma-idb/target-idb/pack";
import { decodeJsonRecord, validateRecord, idbCodecLookup } from "@prisma-idb/target-idb/runtime";
import { createSqlSyncAdapter } from "../src/core/create-adapter";
import { ormRootFor } from "../src/core/orm-root";
import { testContract, testDb, testSyncServer, seed } from "./helpers";

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
        dates: "DateTime[]",
        bigs: "BigInt[]",
        bytes: "Bytes[]",
        decimals: "Decimal[]",
        jsons: "Json[]",
      },
    },
  },
});

it("round-trips scalar-list codecs through Postgres push, pull and IDB decoding", async () => {
  const db = await testDb();
  await seed(db, { User: [{ id: "u1", name: "Owner" }] });
  const adapter = createSqlSyncAdapter({ contract: testContract, syncServer: testSyncServer, contractCheck: "off" });
  const wire = {
    id: "list-1",
    ownerId: "u1",
    tags: ["a"],
    dates: ["2026-01-02T03:04:05.000Z"],
    bigs: ["42"],
    bytes: ["AQI="],
    decimals: ["1.25"],
    jsons: [{ nested: [true] }],
  };
  const native = { ...wire, dates: [new Date(wire.dates[0]!)], bigs: [42n], bytes: [new Uint8Array([1, 2])] };
  const pushed = await adapter.applyPush(db, {
    scopeKey: "u1",
    events: [{ id: "list-create", entityType: "ListItem", operation: "create", payload: wire }],
  });
  expect(pushed).toEqual({ ok: true, results: [{ id: "list-create", success: true }] });
  expect(await ormRootFor(db, "ListItem").first({ id: "list-1" })).toEqual(native);
  const pulled = await adapter.pull(db, { scopeKey: "u1" });
  expect(pulled.ok).toBe(true);
  if (!pulled.ok) return;
  const record = pulled.logs.find((log) => log.model === "ListItem")!.record!;
  expect(record).toEqual(native);
  const fields = clientContract.domain.namespaces["__unbound__"]!.models["ListItem"]!.fields;
  // HTTP transports encode each native list element with its declared JSON codec.
  const encoded = Object.fromEntries(
    Object.entries(record).map(([name, value]) => {
      const field = fields[name]!;
      const codec = field.type.kind === "scalar" ? idbCodecLookup.get(field.type.codecId) : undefined;
      return [
        name,
        field.many && Array.isArray(value) && codec ? value.map((element) => codec.encodeJson(element)) : value,
      ];
    })
  );
  expect(encoded).toEqual(wire);
  const decoded = decodeJsonRecord(clientContract.domain, "ListItem", JSON.parse(JSON.stringify(encoded)));
  expect(decoded).toEqual(native);
  expect(validateRecord(clientContract, "ListItem", decoded)).toEqual({ ok: true });
});
