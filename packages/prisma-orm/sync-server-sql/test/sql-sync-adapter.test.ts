import { describe, expect, it } from "vitest";
import type { OwnershipCheck } from "@prisma-idb/sync-server";
import { sqlGetKeyField } from "../src/core/get-key-field";
import { ormRootFor } from "../src/core/orm-root";
import { toSyncPushPayload, applyPushEvent } from "../src/core/push";
import { reviveWireValues } from "../src/core/wire-values";
import { checkAuthorization } from "../src/core/authorization";
import { resolvePullRecord } from "../src/core/resolve-pull-record";
import { createSqlSyncAdapter } from "../src/core/create-adapter";
import { testContract, testDb, seed } from "./helpers";

describe("wire revival", () => {
  it.each(["pg/date@1", "pg/timestamp@1", "pg/timestamptz@1", "sql/timestamp@1"])(
    "revives historical %s Date values and keys before validation",
    (codecId) => {
      const contract = structuredClone(testContract);
      const fields = contract.domain.namespaces["public"]!.models["Todo"]!.fields;
      fields["dueAt"] = { ...fields["dueAt"]!, type: { kind: "scalar", codecId } };
      const date = "2026-01-02T03:04:05.000Z";
      expect(reviveWireValues(contract, "Todo", { dueAt: date }, "dueAt")).toEqual({ dueAt: new Date(date) });
    }
  );

  it("decodes dates, bigint, bytes and scalar lists before native validation", () => {
    const contract = structuredClone(testContract);
    const fields = contract.domain.namespaces["public"]!.models["Todo"]!.fields;
    fields["big"] = { nullable: false, type: { kind: "scalar", codecId: "pg/int8@1" } };
    fields["bytes"] = { nullable: false, type: { kind: "scalar", codecId: "pg/bytea@1" } };
    fields["dates"] = { nullable: false, many: true, type: { kind: "scalar", codecId: "pg/timestamptz-date@1" } };
    const date = "2026-01-02T03:04:05.000Z";
    const wire = { dueAt: date, big: "42", bytes: "AQI=", dates: [date] };
    expect(reviveWireValues(contract, "Todo", wire)).toEqual({
      dueAt: new Date(date),
      big: 42n,
      bytes: new Uint8Array([1, 2]),
      dates: [new Date(date)],
    });
    expect(wire.big).toBe("42");
    expect(() => reviveWireValues(contract, "Todo", { big: "invalid" })).toThrow();
    expect(() => reviveWireValues(contract, "Todo", { big: "invalid" }, "big")).toThrowError(
      expect.objectContaining({ code: "KEYPATH_VALIDATION_FAILURE" })
    );
  });
});

describe("sqlGetKeyField", () => {
  it("resolves the single-column primary key from the contract's SQL storage", () => {
    expect(sqlGetKeyField(testContract, "User")).toBe("id");
    expect(sqlGetKeyField(testContract, "Board")).toBe("id");
  });

  it("throws for a model with no table/namespaceId in storage", () => {
    expect(() => sqlGetKeyField(testContract, "Nonexistent")).toThrow(/no table\/namespaceId/);
  });
});

describe("ormRootFor", () => {
  it("returns the model root when present", () => {
    const db = {
      orm: { public: { User: { first: async () => null, select: () => ({}) as never, where: () => ({}) as never } } },
    };
    expect(ormRootFor(db, "User")).toBeDefined();
  });

  it("throws when the model isn't on db.orm.public", () => {
    const db = { orm: { public: {} } };
    expect(() => ormRootFor(db, "Ghost")).toThrow(/not found on db\.orm\.public/);
  });
});

describe("toSyncPushPayload", () => {
  it("passes create payloads through unchanged", () => {
    expect(toSyncPushPayload("create", { id: "1", name: "Ann" }, "id")).toEqual({ id: "1", name: "Ann" });
  });

  it("extracts the key field from an update payload", () => {
    expect(toSyncPushPayload("update", { key: "1", patch: { name: "Bo" } }, "id")).toEqual({ name: "Bo", id: "1" });
  });

  it("rejects patches that would override the event's ownership key", () => {
    expect(() => toSyncPushPayload("update", { key: "1", patch: { id: "2" } }, "id")).toThrow(/primary key/);
  });

  it("throws on an update payload missing a key", () => {
    expect(() => toSyncPushPayload("update", { patch: {} }, "id")).toThrow(/does not pin/);
  });

  it("extracts the key field from a delete payload", () => {
    expect(toSyncPushPayload("delete", { key: "1" }, "id")).toEqual({ id: "1" });
  });

  it("throws on an unsupported operation", () => {
    expect(() => toSyncPushPayload("upsert", {}, "id")).toThrow(/Unsupported operation/);
  });
});

describe("checkAuthorization", () => {
  const contract = testContract;
  const getKeyField = sqlGetKeyField;

  it("unknown-model is never authorized", async () => {
    const db = await testDb();
    const authorized = await checkAuthorization(db, contract, getKeyField, "Ghost", { kind: "unknown-model" }, null);
    expect(authorized).toBe(false);
  });

  it("root check trusts its own `authorized` verdict", async () => {
    const db = await testDb();
    const check: OwnershipCheck = { kind: "root", keyField: "id", key: "u1", scopeKey: "u1", authorized: true };
    expect(await checkAuthorization(db, contract, getKeyField, "User", check, { id: "u1" })).toBe(true);
  });

  it("scoped check walks the relation path to the root's key", async () => {
    const db = await testDb();
    await seed(db, {
      User: [{ id: "u1", name: "Ann" }],
      Board: [{ id: "b1", ownerId: "u1" }],
    });
    const check: OwnershipCheck = {
      kind: "scoped",
      keyField: "id",
      key: "b1",
      rootKeyField: "id",
      scopeKey: "u1",
      paths: [["owner"]],
    };
    const startRow = { id: "b1", ownerId: "u1" };
    expect(await checkAuthorization(db, contract, getKeyField, "Board", check, startRow)).toBe(true);
  });

  it("scoped check fails when the path resolves to a different scopeKey", async () => {
    const db = await testDb();
    await seed(db, {
      User: [{ id: "u2", name: "Bo" }],
      Board: [{ id: "b1", ownerId: "u2" }],
    });
    const check: OwnershipCheck = {
      kind: "scoped",
      keyField: "id",
      key: "b1",
      rootKeyField: "id",
      scopeKey: "u1",
      paths: [["owner"]],
    };
    const startRow = { id: "b1", ownerId: "u2" };
    expect(await checkAuthorization(db, contract, getKeyField, "Board", check, startRow)).toBe(false);
  });

  it("scoped check with no startRow (deleted/never existed) is unauthorized", async () => {
    const db = await testDb();
    const check: OwnershipCheck = {
      kind: "scoped",
      keyField: "id",
      key: "b1",
      rootKeyField: "id",
      scopeKey: "u1",
      paths: [["owner"]],
    };
    expect(await checkAuthorization(db, contract, getKeyField, "Board", check, null)).toBe(false);
  });
});

describe("applyPushEvent", () => {
  const contract = testContract;
  const getKeyField = sqlGetKeyField;

  it("creates a row and stamps a Changelog entry when authorized", async () => {
    const db = await testDb();
    const check: OwnershipCheck = { kind: "root", keyField: "id", key: "u1", scopeKey: "u1", authorized: true };
    const result = await applyPushEvent(
      db,
      contract,
      getKeyField,
      { id: "evt1", operation: "create", payload: { id: "u1", name: "Ann" } },
      "User",
      check,
      "u1"
    );
    expect(result).toEqual({ id: "evt1", success: true });
    expect(await ormRootFor(db, "User").first({ id: "u1" })).toEqual({ id: "u1", name: "Ann" });
    const changelogRows = await (
      db.orm["public"] as unknown as { Changelog: { all(): Promise<{ createdAt: unknown }[]> } }
    ).Changelog.all();
    expect(changelogRows).toHaveLength(1);
    // `DateTime` decodes to a JS `Date` (the codec IDB clients sync with), not
    // rc.12's default `Temporal.Instant`, which needs a global `Temporal`.
    expect(changelogRows[0]?.createdAt).toBeInstanceOf(Date);
  });

  it("rejects with SCOPE_VIOLATION when authorization fails, without writing the row", async () => {
    const db = await testDb();
    await seed(db, {
      User: [{ id: "u2", name: "Bo" }],
      Board: [{ id: "b1", ownerId: "u2" }],
    });
    const check: OwnershipCheck = {
      kind: "scoped",
      keyField: "id",
      key: "b1",
      rootKeyField: "id",
      scopeKey: "u1",
      paths: [["owner"]],
    };
    const result = await applyPushEvent(
      db,
      contract,
      getKeyField,
      { id: "evt2", operation: "delete", payload: { key: "b1" } },
      "Board",
      check,
      "u1"
    );
    expect(result).toEqual({ id: "evt2", success: false, error: "SCOPE_VIOLATION", retryable: false });
    expect(await ormRootFor(db, "Board").first({ id: "b1" })).not.toBeNull();
  });

  it("revives JSON-wire ISO strings into Dates for DateTime fields on create and update", async () => {
    const db = await testDb();
    await seed(db, {
      User: [{ id: "u1", name: "Ann" }],
      Board: [{ id: "b1", ownerId: "u1" }],
    });
    const check: OwnershipCheck = {
      kind: "scoped",
      keyField: "id",
      key: "t1",
      rootKeyField: "id",
      scopeKey: "u1",
      paths: [["board", "owner"]],
    };
    // A client `Date` after JSON.stringify — what an outbox event carries.
    const created = await applyPushEvent(
      db,
      contract,
      getKeyField,
      { id: "evt1", operation: "create", payload: { id: "t1", boardId: "b1", dueAt: "2026-01-02T03:04:05.000Z" } },
      "Todo",
      check,
      "u1"
    );
    expect(created).toEqual({ id: "evt1", success: true });
    expect((await ormRootFor(db, "Todo").first({ id: "t1" }))?.["dueAt"]).toEqual(new Date("2026-01-02T03:04:05.000Z"));

    const updated = await applyPushEvent(
      db,
      contract,
      getKeyField,
      { id: "evt2", operation: "update", payload: { key: "t1", patch: { dueAt: "2026-02-03T04:05:06.000Z" } } },
      "Todo",
      check,
      "u1"
    );
    expect(updated).toEqual({ id: "evt2", success: true });
    expect((await ormRootFor(db, "Todo").first({ id: "t1" }))?.["dueAt"]).toEqual(new Date("2026-02-03T04:05:06.000Z"));
  });

  it("is idempotent on the event id — re-applying is a no-op success", async () => {
    const db = await testDb();
    await seed(db, {
      User: [{ id: "u1", name: "Ann" }],
      Changelog: [{ model: "User", keyPath: "u1", operation: "update", scopeKey: "u1", outboxEventId: "evt1" }],
    });
    const check: OwnershipCheck = { kind: "root", keyField: "id", key: "u1", scopeKey: "u1", authorized: true };
    const result = await applyPushEvent(
      db,
      contract,
      getKeyField,
      { id: "evt1", operation: "update", payload: { key: "u1", patch: { name: "Changed" } } },
      "User",
      check,
      "u1"
    );
    expect(result).toEqual({ id: "evt1", success: true });
    expect(await ormRootFor(db, "User").first({ id: "u1" })).toEqual({ id: "u1", name: "Ann" }); // untouched
  });

  it("reports unknown-model without touching the database", async () => {
    const db = await testDb();
    const result = await applyPushEvent(
      db,
      contract,
      getKeyField,
      { id: "evt3", operation: "create", payload: {} },
      "Ghost",
      { kind: "unknown-model" },
      "u1"
    );
    expect(result).toEqual({ id: "evt3", success: false, error: "Unknown model", retryable: false });
  });
});

describe("resolvePullRecord", () => {
  const contract = testContract;
  const getKeyField = sqlGetKeyField;

  it("returns the current row when authorized", async () => {
    const db = await testDb();
    await seed(db, { User: [{ id: "u1", name: "Ann" }] });
    const check: OwnershipCheck = { kind: "root", keyField: "id", key: "u1", scopeKey: "u1", authorized: true };
    const record = await resolvePullRecord(db, contract, getKeyField, "User", check, "u1", "update");
    expect(record).toEqual({ id: "u1", name: "Ann" });
  });

  it("returns null for a delete operation even when authorized", async () => {
    const db = await testDb();
    await seed(db, { User: [{ id: "u1", name: "Ann" }] });
    const check: OwnershipCheck = { kind: "root", keyField: "id", key: "u1", scopeKey: "u1", authorized: true };
    const record = await resolvePullRecord(db, contract, getKeyField, "User", check, "u1", "delete");
    expect(record).toBeNull();
  });

  it("returns null when unauthorized", async () => {
    const db = await testDb();
    await seed(db, {
      User: [{ id: "u2", name: "Bo" }],
      Board: [{ id: "b1", ownerId: "u2" }],
    });
    const check: OwnershipCheck = {
      kind: "scoped",
      keyField: "id",
      key: "b1",
      rootKeyField: "id",
      scopeKey: "u1",
      paths: [["owner"]],
    };
    const record = await resolvePullRecord(db, contract, getKeyField, "Board", check, "b1", "update");
    expect(record).toBeNull();
  });

  it("returns the current row for an authorized scoped check, reusing the ownership-walk fetch", async () => {
    const db = await testDb();
    await seed(db, {
      User: [{ id: "u1", name: "Ann" }],
      Board: [{ id: "b1", ownerId: "u1" }],
    });
    const check: OwnershipCheck = {
      kind: "scoped",
      keyField: "id",
      key: "b1",
      rootKeyField: "id",
      scopeKey: "u1",
      paths: [["owner"]],
    };
    const record = await resolvePullRecord(db, contract, getKeyField, "Board", check, "b1", "update");
    expect(record).toEqual({ id: "b1", ownerId: "u1" });
  });
});

describe("createSqlSyncAdapter", () => {
  it("wires getKeyField/toSyncPushPayload/applyPushEvent/resolvePullRecord against one contract", async () => {
    const adapter = createSqlSyncAdapter({ contract: testContract });
    expect(adapter.getKeyField("User")).toBe("id");

    const db = await testDb();
    await seed(db, { User: [{ id: "u1", name: "Ann" }] });
    const check: OwnershipCheck = { kind: "root", keyField: "id", key: "u1", scopeKey: "u1", authorized: true };
    const result = await adapter.applyPushEvent(
      db,
      { id: "evt1", operation: "create", payload: { id: "u2", name: "Bo" } },
      "User",
      { ...check, key: "u2" },
      "u1"
    );
    expect(result).toEqual({ id: "evt1", success: true });

    const record = await adapter.resolvePullRecord(db, "User", check, "u1", "update");
    expect(record).toEqual({ id: "u1", name: "Ann" });
  });
});
