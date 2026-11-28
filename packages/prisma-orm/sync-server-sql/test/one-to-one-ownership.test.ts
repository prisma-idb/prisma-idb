/**
 * A one-to-one relation carries sync ownership from the side whose table holds
 * the foreign key. These tests use a contract emitted from a real schema, where
 * the table and column names are mapped (`profiles.user_id`).
 */
import { describe, expect, it, vi } from "vitest";
import { createSyncServer, resolveAuthorizationPaths } from "@prisma-idb/sync-server";
import type { PushCheck, SyncServerContract } from "@prisma-idb/sync-server";
import { createSqlSyncAdapter } from "../src/core/create-adapter";
import { resolvePullRecord } from "../src/core/resolve-pull-record";
import { sqlGetKeyField } from "../src/core/get-key-field";
import { testClientContract, testContract, testDb } from "./helpers";

const publicNamespace = testContract.domain.namespaces["public"]!;
const clientNamespace = testClientContract.domain.namespaces["public"]!;

/** The client contract with only the models the test syncs, as an app's `@idb.exclude` would leave. */
const profileClientContract = {
  ...testClientContract,
  domain: {
    namespaces: {
      public: {
        ...clientNamespace,
        models: {
          User: publicNamespace.models["User"]!,
          Profile: publicNamespace.models["Profile"]!,
          ProfileTask: publicNamespace.models["ProfileTask"]!,
        },
      },
    },
  },
};

describe("a one-to-one foreign key in an emitted SQL contract", () => {
  it("emits the foreign key on the owning table, under its mapped names", () => {
    const tables = (
      testContract.storage as unknown as {
        namespaces: Record<
          string,
          { entries: { table: Record<string, { foreignKeys?: { source: { columns: string[] } }[] }> } }
        >;
      }
    ).namespaces["public"]!.entries.table;
    expect(tables["profiles"]?.foreignKeys?.map((key) => key.source.columns)).toEqual([["user_id"]]);
    expect(tables["User"]?.foreignKeys ?? []).toEqual([]);
  });

  it("carries ownership from Profile.user to the root", () => {
    expect(resolveAuthorizationPaths(testContract, "User", "Profile")).toEqual([["user"]]);
  });

  it("does not let the inverse side, User.profile, own the foreign key", () => {
    // If User.profile carried ownership, User would reach a root of Profile through it.
    expect(() =>
      createSyncServer({
        contract: testContract,
        clientContract: profileClientContract,
        rootModel: "Profile",
        getKeyField: sqlGetKeyField,
      })
    ).toThrow(/User.*no path/s);
    expect(resolveAuthorizationPaths(testContract, "Profile", "User")).toEqual([]);
  });

  it("follows a many-to-one relation through the owning one-to-one relation", async () => {
    expect(resolveAuthorizationPaths(testContract, "User", "ProfileTask")).toEqual([["profile", "user"]]);
    const db = await testDb();
    const syncServer = createSyncServer({
      contract: testContract,
      clientContract: profileClientContract,
      rootModel: "User",
      getKeyField: sqlGetKeyField,
    });
    const adapter = createSqlSyncAdapter({ contract: testContract, syncServer, contractCheck: "off" });
    const events = [
      { id: "user", entityType: "User", operation: "create", payload: { id: "u1", name: "Ann" } },
      { id: "profile", entityType: "Profile", operation: "create", payload: { id: "p1", userId: "u1" } },
      { id: "task", entityType: "ProfileTask", operation: "create", payload: { id: "t1", profileId: "p1" } },
    ] as const;
    expect(await adapter.applyPush(db, { scopeKey: "u1", events })).toEqual({
      ok: true,
      results: events.map(({ id }) => ({ id, success: true })),
    });
    expect(await adapter.pull(db, { scopeKey: "u1" })).toMatchObject({
      ok: true,
      logs: events.map(({ entityType, payload }) => ({ model: entityType, record: payload })),
    });
  });

  it("pushes and pulls a Profile only for the user who owns it", async () => {
    const db = await testDb();
    const syncServer = createSyncServer({
      contract: testContract,
      clientContract: profileClientContract,
      rootModel: "User",
      getKeyField: sqlGetKeyField,
    });
    const adapter = createSqlSyncAdapter({ contract: testContract, syncServer, contractCheck: "off" });
    const users = [
      { id: "a", entityType: "User", operation: "create" as const, payload: { id: "u1", name: "Ann" } },
      { id: "b", entityType: "User", operation: "create" as const, payload: { id: "u2", name: "Bo" } },
    ];
    await adapter.applyPush(db, { scopeKey: "u1", events: users.slice(0, 1) });
    await adapter.applyPush(db, { scopeKey: "u2", events: users.slice(1) });

    const mine = { id: "p1", entityType: "Profile", operation: "create" as const, payload: { id: "p1", userId: "u1" } };
    const theirs = { ...mine, id: "p2", payload: { id: "p2", userId: "u2" } };
    expect(await adapter.applyPush(db, { scopeKey: "u1", events: [mine] })).toEqual({
      ok: true,
      results: [{ id: "p1", success: true }],
    });
    expect(await adapter.applyPush(db, { scopeKey: "u1", events: [theirs] })).toMatchObject({
      ok: true,
      results: [{ id: "p2", success: false, error: "SCOPE_VIOLATION" }],
    });

    const unowned = { ...mine, id: "unowned", payload: { id: "unowned", userId: null } };
    expect(await adapter.applyPush(db, { scopeKey: "u1", events: [unowned] })).toMatchObject({
      ok: true,
      results: [{ id: "unowned", success: false, error: "SCOPE_VIOLATION", retryable: false }],
    });
    expect(await db.orm.public.Profile.first({ id: "unowned" })).toBeNull();

    const pulled = await adapter.pull(db, { scopeKey: "u1" });
    expect(pulled).toMatchObject({
      ok: true,
      logs: [{ model: "User" }, { model: "Profile", keyPath: "p1", record: { id: "p1", userId: "u1" } }],
    });
  });
});

/** The emitted contract with `Profile.user` joined on `User.name`, a column that isn't the key. */
function joinedOnNonKeyColumn(cardinality: "1:1" | "N:1"): SyncServerContract {
  const contract = structuredClone(testContract) as unknown as {
    domain: {
      namespaces: Record<
        string,
        {
          models: Record<
            string,
            { relations: Record<string, { cardinality: string; on: { targetFields: string[] } }> }
          >;
        }
      >;
    };
    storage: {
      namespaces: Record<
        string,
        { entries: { table: Record<string, { foreignKeys: { target: { columns: string[] } }[] }> } }
      >;
    };
  };
  const relation = contract.domain.namespaces["public"]!.models["Profile"]!.relations["user"]!;
  relation.cardinality = cardinality;
  relation.on.targetFields = ["name"];
  contract.storage.namespaces["public"]!.entries.table["profiles"]!.foreignKeys[0]!.target.columns = ["name"];
  return contract as unknown as SyncServerContract;
}

describe("applying a delete through an owning relation", () => {
  const event = { id: "e1", operation: "delete", payload: { key: "p1" } } as const;
  const check: PushCheck = {
    kind: "scoped",
    keyField: "id",
    key: "p1",
    rootKeyField: "id",
    scopeKey: "bob",
    paths: [["user"]],
  };

  it.each(["1:1", "N:1"] as const)(
    "refuses a %s join on a column other than the parent's key before opening a transaction",
    async (cardinality) => {
      const transaction = vi.fn();
      const adapter = createSqlSyncAdapter({ contract: joinedOnNonKeyColumn(cardinality) });

      await expect(adapter.applyPushEvent({ transaction }, event, "Profile", check, "bob")).rejects.toThrow(
        /Unsupported tenant parent join "Profile\.user"/
      );
      expect(transaction).not.toHaveBeenCalled();
    }
  );

  it("refuses a caller-supplied pull check that follows a join other than the parent's key", async () => {
    const syncServer = createSyncServer({
      contract: testContract,
      clientContract: profileClientContract,
      rootModel: "User",
      getKeyField: sqlGetKeyField,
    });
    const adapter = createSqlSyncAdapter({ contract: testContract, syncServer, contractCheck: "off" });
    const transaction = vi.fn();

    // `User.profile` is the inverse side: it joins `Profile.userId`, which isn't `Profile`'s key.
    await expect(
      adapter.resolvePullRecord(
        { transaction },
        "User",
        { kind: "scoped", keyField: "id", key: "u1", rootKeyField: "id", scopeKey: "u1", paths: [["profile"]] },
        "u1",
        "update"
      )
    ).rejects.toThrow(/Unsupported tenant parent join "User\.profile"/);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("refuses the same check in the resolver that paged pulls and push reconciliation share", async () => {
    const syncServer = createSyncServer({
      contract: testContract,
      clientContract: profileClientContract,
      rootModel: "User",
      getKeyField: sqlGetKeyField,
    });

    // A wrapped `SyncServer` can return a check the stock server never would.
    await expect(
      resolvePullRecord(
        {},
        syncServer,
        testContract,
        sqlGetKeyField,
        "User",
        { kind: "scoped", keyField: "id", key: "u1", rootKeyField: "id", scopeKey: "u1", paths: [["profile"]] },
        "u1",
        "update"
      )
    ).rejects.toThrow(/Unsupported tenant parent join "User\.profile"/);
  });

  it("still opens a transaction for a join on the parent's key", async () => {
    const transaction = vi.fn().mockRejectedValue(new Error("stop after validation"));
    const adapter = createSqlSyncAdapter({ contract: testContract });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await adapter.applyPushEvent({ transaction }, event, "Profile", check, "bob");
      expect(transaction).toHaveBeenCalledOnce();
    } finally {
      vi.restoreAllMocks();
    }
  });
});
