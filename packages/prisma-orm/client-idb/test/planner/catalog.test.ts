import { describe, expect, it } from "vitest";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import family from "@prisma-idb/family-idb/pack";
import target from "@prisma-idb/target-idb/pack";
import { buildCatalog } from "../../src/core/planner/catalog";

const contract = defineContract({
  family,
  target,
  enums: { Tag: ["one", "two"] },
  models: {
    Item: {
      store: "items",
      key: "id",
      fields: { id: "String", a: "String", b: "String?", count: "Int", tags: "Tag[]" },
      indexes: { ab: { keyPath: ["a", "b"], unique: true } },
    },
    Pair: { store: "pairs", key: ["a", "b"], fields: { a: "String", b: "Int" } },
  },
});

describe("buildCatalog", () => {
  it("records storage paths, index flags, codecs, and nullability", () => {
    const c = buildCatalog(contract, "items", "Item");
    expect(c.primaryKey).toEqual({ keyPath: "id", fields: ["id"], unique: true, multiEntry: false });
    expect(c.indexes).toEqual([
      { indexName: "ab", keyPath: ["a", "b"], fields: ["a", "b"], unique: true, multiEntry: false },
    ]);
    expect(c.fields).toMatchObject({
      a: { codecId: "idb/string@1", nullable: false, collection: false },
      b: { nullable: true },
      count: { codecId: "idb/int32@1" },
      tags: { collection: true },
    });
  });
  it("keeps compound key order and leaves the input contract unchanged", () => {
    const before = structuredClone(contract);
    expect(buildCatalog(contract, "pairs", "Pair").primaryKey.keyPath).toEqual(["a", "b"]);
    expect(contract).toEqual(before);
  });
  describe("models that share a store (contracts emitted before shared stores were refused)", () => {
    // defineContract refuses shared stores now, so point the second model at the first model's store by hand.
    const legacy = structuredClone(
      defineContract({
        family,
        target,
        models: {
          Plain: { store: "shared", key: "id", fields: { id: "String" } },
          Nullable: { store: "other", key: "id", fields: { id: "String", note: "String?" } },
        },
      })
    ) as unknown as {
      domain: { namespaces: Record<string, { models: Record<string, { storage: { storeName?: string } }> }> };
      storage: { stores: Record<string, unknown> };
    };
    const models = Object.values(legacy.domain.namespaces)[0]!.models;
    models["Nullable"]!.storage.storeName = "shared";
    delete legacy.storage.stores["other"];

    it("reads the rows of each model, not of the last model that maps to the store", () => {
      const shared = legacy as unknown as typeof contract;
      const row = { id: "1" };
      expect(buildCatalog(shared, "shared", "Plain").absentAsNull(row)).toEqual({ id: "1" });
      expect(buildCatalog(shared, "shared", "Nullable").absentAsNull(row)).toEqual({ id: "1", note: null });
    });
  });
  it("reports an unknown store, an unknown model and a model of another store", () => {
    expect(() => buildCatalog(contract, "missing")).toThrow('Store "missing" is not in the contract');
    expect(() => buildCatalog(contract, "items", "Nope")).toThrow('Model "Nope" is not in the contract');
    expect(() => buildCatalog(contract, "items", "Pair")).toThrow('Model "Pair" is not stored in "items"');
  });
  it("gives a store without a model no fields to fill", () => {
    const c = buildCatalog(contract, "items");
    expect(c.fields).toEqual({});
    expect(c.absentAsNull({ id: "1" })).toEqual({ id: "1" });
  });
});
