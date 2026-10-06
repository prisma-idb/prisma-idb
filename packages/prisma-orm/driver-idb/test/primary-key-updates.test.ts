import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeIdbPlan } from "../src/core/execute";
import { createTransactionScope } from "../src/core/transaction-scope";
import type { IdbAtomicPlan } from "../src/core/plan-body";
const meta = { target: "idb", storageHash: "test", lane: "test" } as const;
let counter = 0;
const original = { id: "i1", serial: 1, label: "x" };
function read(db: IDBDatabase): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const req = db.transaction("items").objectStore("items").getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
describe("primary-key changes and callback failures", () => {
  let db: IDBDatabase;
  beforeEach(async () => {
    db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(`driver-pk-${++counter}`, 1);
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore("items", { keyPath: "id" });
        store.createIndex("bySerial", "serial");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    await executeIdbPlan(db, { meta, kind: "add", storeName: "items", record: original });
  });
  afterEach(() => {
    db.close();
    indexedDB.deleteDatabase(db.name);
  });
  const plans: IdbAtomicPlan[] = [
    { meta, kind: "scan-write", storeName: "items", write: "put-merged", patch: { id: "z9" } },
    {
      meta,
      kind: "scan-write",
      storeName: "items",
      indexName: "bySerial",
      range: { kind: "only", key: 1 },
      write: "put-merged",
      patch: { id: "z9" },
    },
    { meta, kind: "update", storeName: "items", key: "i1", patch: { id: "z9" } },
  ];
  for (const scoped of [false, true]) {
    it.each(plans)(
      `rejects key changes without duplicating rows (scoped=${scoped}): $kind $indexName`,
      async (plan) => {
        const scope = scoped ? createTransactionScope(db, ["items"]) : undefined;
        const result = scope ? scope.execute(plan) : executeIdbPlan(db, plan);
        await expect(result).rejects.toMatchObject({ code: "PRIMARY_KEY_CHANGE_UNSUPPORTED" });
        await expect(result).rejects.toThrow(/Delete the row and create a new one/);
        if (scope) await expect(scope.commit()).rejects.toThrow();
        expect(await read(db)).toEqual([original]);
      },
      1000
    );
  }
  it("settles all pending execute promises after rollback", async () => {
    const scope = createTransactionScope(db, ["items"]);
    // Simulate a request that supplies no per-request error callback on native abort.
    const get = vi.spyOn(IDBObjectStore.prototype, "get").mockReturnValue({} as IDBRequest);
    const pending = [1, 2].map(() => scope.execute({ meta, kind: "key-get", storeName: "items", key: "i1" }));
    get.mockRestore();
    const rejected = pending.map((promise) => expect(promise).rejects.toMatchObject({ code: "TRANSACTION_ABORTED" }));
    scope.rollback();
    await Promise.all(rejected);
    await expect(scope.commit()).rejects.toThrow();
  }, 1000);
  it("rolls back earlier cursor writes when a later callback throws", async () => {
    await executeIdbPlan(db, { meta, kind: "add", storeName: "items", record: { id: "i2", serial: 2, label: "x" } });
    const scope = createTransactionScope(db, ["items"]);
    await expect(
      scope.execute({
        meta,
        kind: "scan-write",
        storeName: "items",
        write: "put-merged",
        patch: { label: "y" },
        filter(row) {
          if (row["id"] === "i2") throw new Error("filter failed");
          return true;
        },
      })
    ).rejects.toThrow(/filter failed/);
    await expect(scope.commit()).rejects.toThrow();
    expect(await read(db)).toEqual([original, { id: "i2", serial: 2, label: "x" }]);
  }, 1000);
  it.each(["update", "scan-write"] as const)(
    "rejects a synchronous DataCloneError from %s",
    async (kind) => {
      const scope = createTransactionScope(db, ["items"]);
      const patch = { label: () => "uncloneable" };
      const plan: IdbAtomicPlan =
        kind === "update"
          ? { meta, kind, storeName: "items", key: "i1", patch }
          : { meta, kind, storeName: "items", write: "put-merged", patch };
      await expect(scope.execute(plan)).rejects.toMatchObject({
        code: "PUT_FAILED",
        cause: { name: "DataCloneError" },
      });
      await expect(scope.commit()).rejects.toThrow();
      expect(await read(db)).toEqual([original]);
    },
    1000
  );
  it("rolls back earlier batch writes when a later key change fails", async () => {
    await expect(
      executeIdbPlan(db, {
        meta,
        kind: "batch",
        storeNames: ["items"],
        ops: [
          { meta, kind: "update", storeName: "items", key: "i1", patch: { label: "y" } },
          { meta, kind: "update", storeName: "items", key: "i1", patch: { id: "z9" } },
        ],
      })
    ).rejects.toMatchObject({ code: "PRIMARY_KEY_CHANGE_UNSUPPORTED" });
    expect(await read(db)).toEqual([original]);
  });
});

describe("key identity and synchronous write errors", () => {
  const cases: {
    name: string;
    keyPath: string | string[];
    record: Record<string, unknown>;
    key: IDBValidKey;
    same: Record<string, unknown>;
    changed: Record<string, unknown>;
  }[] = [
    {
      name: "compound",
      keyPath: ["tenant", "id"],
      record: { tenant: "t", id: "i1" },
      key: ["t", "i1"],
      same: { tenant: "t" },
      changed: { tenant: "other" },
    },
    {
      name: "dotted",
      keyPath: "identity.id",
      record: { identity: { id: "i1" } },
      key: "i1",
      same: { identity: { id: "i1" } },
      changed: { identity: { id: "z9" } },
    },
    {
      name: "date",
      keyPath: "id",
      record: { id: new Date(123) },
      key: new Date(123),
      same: { id: new Date(123) },
      changed: { id: new Date(456) },
    },
    {
      name: "binary",
      keyPath: "id",
      record: { id: new Uint8Array([1, 2]) },
      key: new Uint8Array([1, 2]),
      same: { id: new Uint8Array([1, 2]) },
      changed: { id: new Uint8Array([3, 4]) },
    },
  ];
  it.each(cases)(
    "allows equivalent $name keys and rejects changed keys",
    async ({ keyPath, record, key, same, changed }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(`driver-pk-identity-${++counter}`, 1);
        req.onupgradeneeded = () => req.result.createObjectStore("items", { keyPath });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      try {
        await executeIdbPlan(db, { meta, kind: "add", storeName: "items", record });
        for (const kind of ["update", "scan-write"] as const) {
          const plan: IdbAtomicPlan =
            kind === "update"
              ? { meta, kind, storeName: "items", key, patch: same }
              : { meta, kind, storeName: "items", write: "put-merged", patch: same };
          expect(await executeIdbPlan(db, plan)).toEqual([record]);
          await expect(executeIdbPlan(db, { ...plan, patch: changed })).rejects.toMatchObject({
            code: "PRIMARY_KEY_CHANGE_UNSUPPORTED",
          });
          expect(await read(db)).toEqual([record]);
        }
      } finally {
        db.close();
        indexedDB.deleteDatabase(db.name);
      }
    }
  );
});
