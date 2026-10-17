import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import idbFamilyPack from "@prisma-idb/family-idb/pack";
import idbTargetPack from "@prisma-idb/target-idb/pack";
import { createIdbClient } from "../src/exports/client";
import type { IdbContract } from "../src/exports/orm";

// Deliberately omit type maps: runtime validation must also protect loose contracts.
const baseContract = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  models: {
    Sample: {
      store: "samples",
      key: "id",
      fields: {
        id: "String",
        group: "String",
        n: "Float?",
        integer: "Int?",
        text: "String?",
        date: "DateTime?",
        big: "BigInt?",
        decimal: "Decimal?",
      },
    },
  },
});
// The authoring helper omits numeric containers; valid contracts can still declare them.
const contract: IdbContract = {
  ...baseContract,
  domain: {
    ...baseContract.domain,
    namespaces: Object.fromEntries(
      Object.entries(baseContract.domain.namespaces).map(([name, namespace]) => {
        const sample = namespace.models["Sample"]!;
        return [
          name,
          {
            ...namespace,
            models: {
              ...namespace.models,
              Sample: {
                ...sample,
                fields: {
                  ...sample.fields,
                  list: { ...sample.fields["integer"]!, many: { elementNullable: false } },
                  dict: { ...sample.fields["integer"]!, dict: true },
                },
              },
            },
          },
        ];
      })
    ),
  },
};
let sequence = 0;
let client: ReturnType<typeof createIdbClient>;
let database: IDBDatabase;

beforeEach(async () => {
  const dbName = `aggregate-validation-${++sequence}`;
  database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(dbName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("samples", { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  client = createIdbClient({ contract, dbName });
});
afterEach(async () => {
  await client.close();
  database.close();
});

/** Seed legacy or externally written records without the local write validator. */
async function seed(rows: Record<string, unknown>[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction("samples", "readwrite");
    rows.forEach((row, index) => transaction.objectStore("samples").put({ id: String(index), group: "a", ...row }));
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
  });
}

for (const grouped of [false, true]) {
  describe(grouped ? "groupBy().aggregate() validation" : "aggregate() validation", () => {
    /** Exercise the same public selectors through both terminal operations. */
    function accessor() {
      const samples = client.orm["samples"]!;
      return grouped ? samples.groupBy("group") : samples;
    }

    it.each(["text", "date", "big", "decimal", "list", "dict", "missing"])(
      "rejects unsupported field %s even on empty sets",
      async (field) => {
        for (const fn of ["sum", "avg", "min", "max"] as const) {
          await expect(accessor().aggregate((agg) => ({ total: agg[fn](field) }))).rejects.toThrow(/number field/);
        }
      }
    );

    it.each(["sum", "avg", "min", "max"] as const)(
      "%s rejects coerced or nonfinite values in number fields",
      async (fn) => {
        for (const n of [
          "12",
          "invalid",
          new Date("2026-01-01"),
          1n,
          9007199254740993n,
          true,
          [],
          {},
          NaN,
          Infinity,
          -Infinity,
        ]) {
          await seed([{ n }]);
          await expect(accessor().aggregate((agg) => ({ value: agg[fn]("n") }))).rejects.toThrow(/finite number/);
        }
      }
    );

    it.each(["sum", "avg", "min", "max"] as const)("%s enforces the declared Int range", async (fn) => {
      for (const integer of [1.5, 2147483648, -2147483649]) {
        await seed([{ integer }]);
        await expect(accessor().aggregate((agg) => ({ value: agg[fn]("integer") }))).rejects.toThrow(/Int values/);
      }
    });

    it.each(["sum", "avg"] as const)("%s rejects nonfinite intermediate totals", async (fn) => {
      for (const n of [Number.MAX_VALUE, -Number.MAX_VALUE]) {
        await seed([{ n }, { n }]);
        await expect(accessor().aggregate((agg) => ({ value: agg[fn]("n") }))).rejects.toThrow(/finite number range/);
      }
    });

    it("keeps finite Float magnitudes and fractional results", async () => {
      await seed([{ n: 1.5 }, { n: 2.25 }, { n: null }, {}]);
      const result = await accessor().aggregate((agg) => ({
        count: agg.count(),
        sum: agg.sum("n"),
        avg: agg.avg("n"),
        min: agg.min("n"),
        max: agg.max("n"),
      }));
      const expected = { count: 4, sum: 3.75, avg: 1.875, min: 1.5, max: 2.25 };
      expect(result).toEqual(grouped ? [{ group: "a", ...expected }] : expected);
    });

    it("does not impose the Int safe-integer limit on Float values", async () => {
      await seed([{ n: Number.MAX_VALUE }]);
      const result = await accessor().aggregate((agg) => ({
        sum: agg.sum("n"),
        avg: agg.avg("n"),
        min: agg.min("n"),
        max: agg.max("n"),
      }));
      const expected = { sum: Number.MAX_VALUE, avg: Number.MAX_VALUE, min: Number.MAX_VALUE, max: Number.MAX_VALUE };
      expect(result).toEqual(grouped ? [{ group: "a", ...expected }] : expected);
    });

    it("returns null for all-null or absent numeric inputs while counting every row", async () => {
      await seed([{ n: null }, {}]);
      const result = await accessor().aggregate((agg) => ({
        count: agg.count(),
        sum: agg.sum("n"),
        avg: agg.avg("n"),
        min: agg.min("n"),
        max: agg.max("n"),
      }));
      const expected = { count: 2, sum: null, avg: null, min: null, max: null };
      expect(result).toEqual(grouped ? [{ group: "a", ...expected }] : expected);
    });

    it("returns the explicit empty-set result", async () => {
      const result = await accessor().aggregate((agg) => ({
        count: agg.count(),
        sum: agg.sum("n"),
        avg: agg.avg("n"),
        min: agg.min("n"),
        max: agg.max("n"),
      }));
      expect(result).toEqual(grouped ? [] : { count: 0, sum: null, avg: null, min: null, max: null });
    });

    it("count ignores unsupported values and malformed numeric fields", async () => {
      await seed([
        { n: Infinity, big: 9007199254740993n, decimal: "9007199254740993.25" },
        { n: "bad", date: new Date() },
      ]);
      const result = await accessor().aggregate((agg) => ({ count: agg.count() }));
      expect(result).toEqual(grouped ? [{ group: "a", count: 2 }] : { count: 2 });
    });

    it("validates every group instead of accepting a valid first group", async () => {
      await seed([
        { group: "a", n: 1 },
        { group: "b", n: "2" },
      ]);
      await expect(accessor().aggregate((agg) => ({ sum: agg.sum("n") }))).rejects.toThrow(/finite number/);
    });
  });
}
