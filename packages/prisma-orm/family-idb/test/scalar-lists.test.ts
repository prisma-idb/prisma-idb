import { canonicalizeContractToObject } from "@prisma/orm-framework/contract/hashing";
import idbTargetControl from "@prisma-idb/target-idb/control";
import { buildSymbolTable } from "@prisma/orm-framework/psl-parser";
import { parse } from "@prisma/orm-framework/psl-parser/syntax";
import { IdbMigrationPlanner } from "@prisma-idb/target-idb/migration";
import idbTarget from "@prisma-idb/target-idb/pack";
import { describe, expect, it } from "vitest";
import { defineContract, type FieldSpec } from "../src/core/contract-builder";
import { interpretPslDocumentToIdbContract } from "../src/core/psl-interpreter";
import idbFamily from "../src/exports/pack";

const scalars = [
  "String",
  "Int",
  "BigInt",
  "Float",
  "Decimal",
  "Boolean",
  "DateTime",
  "Bytes",
  "Json",
  "Role",
] as const;

/** Build the two schema versions used by the migration tests. */
function contract(spec?: FieldSpec<"Role">, defaults?: { values: readonly unknown[] }) {
  return defineContract({
    family: idbFamily,
    target: idbTarget,
    enums: { Role: ["USER", "ADMIN"] },
    models: {
      Sample: {
        store: "sample",
        key: "id",
        fields: { id: "String", ...(spec ? { values: spec } : {}) },
        ...(defaults ? { defaults } : {}),
      },
    },
  });
}

/** Interpret a scalar-list PSL schema through the public binder and validator. */
function psl(spec: string, defaultExpression = "", key = "@id") {
  const { document, sources } = parse(
    `enum Role {\n USER\n ADMIN\n}\nmodel Sample {\n id String ${key}\n values ${spec} ${defaultExpression}\n}`,
    "test.prisma"
  );
  const { symbolTable } = buildSymbolTable({ documents: [document], sources, defaultNamespaceId: "__unbound__" });
  return interpretPslDocumentToIdbContract(symbolTable, "test.prisma");
}

/** Plan from a store without a list to one with the requested list declaration. */
function operations(from: ReturnType<typeof contract>, to: ReturnType<typeof contract>) {
  const result = new IdbMigrationPlanner().plan({
    contract: to,
    fromContract: from,
    origin: null,
    statements: [],
    schema: null,
    frameworkComponents: [],
    spaceId: "app",
    policy: { allowedOperationClasses: ["additive", "widening", "destructive", "data"] },
  });
  if (result.kind !== "success") throw new Error("Expected a successful migration plan");
  return result.plan.operations;
}

describe("scalar lists", () => {
  it.each(scalars)("emits equivalent PSL and TS metadata for %s[] with an empty default", (scalar) => {
    const ts = contract(`${scalar}[]`, { values: [] });
    const result = psl(`${scalar}[]`, "@default([])");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual(ts);
    expect(ts.storage.stores["sample"]!.record!.fields["values"]!.many).toEqual({ elementNullable: false });
  });

  it.each(scalars)("rejects optional %s lists and nonempty defaults", (scalar) => {
    expect(psl(`${scalar}[]?`).ok).toBe(false);
    expect(psl(`${scalar}[]`, '@default(["x"])').ok).toBe(false);
    expect(() => contract(`${scalar}[]`, { values: ["x"] })).toThrow(/Only an empty list default/);
  });

  it.each(scalars)("rejects %s lists in single and compound primary keys", (scalar) => {
    for (const key of ["values", ["id", "values"]] as const) {
      expect(() =>
        defineContract({
          family: idbFamily,
          target: idbTarget,
          enums: { Role: ["USER", "ADMIN"] },
          models: { Sample: { store: "sample", key, fields: { id: "String", values: `${scalar}[]` } } },
        })
      ).toThrow(/IDB_LIST_ID/);
    }
    for (const declaration of ["@id", "\n @@id([id, values])"]) {
      const result = psl(`${scalar}[]`, declaration, "");
      expect(result.ok).toBe(false);
      if (!result.ok)
        expect(result.failure.diagnostics).toEqual(
          expect.arrayContaining([expect.objectContaining({ code: "IDB_LIST_ID" })])
        );
    }
  });

  it.each(scalars)("rejects %s lists in every index form", (scalar) => {
    for (const index of [
      { keyPath: "values" },
      { keyPath: "values", unique: true },
      { keyPath: ["id", "values"] },
      { keyPath: ["id", "values"], unique: true },
      { keyPath: "values", multiEntry: true },
    ] as const) {
      expect(() =>
        defineContract({
          family: idbFamily,
          target: idbTarget,
          enums: { Role: ["USER", "ADMIN"] },
          models: {
            Sample: {
              store: "sample",
              key: "id",
              fields: { id: "String", values: `${scalar}[]` },
              indexes: { byValues: index },
            },
          },
        })
      ).toThrow(/IDB_LIST_INDEX/);
    }
    for (const declaration of [
      "@unique",
      "\n @@index([values])",
      "\n @@unique([values])",
      "\n @@index([id, values])",
      "\n @@unique([id, values])",
    ]) {
      const result = psl(`${scalar}[]`, declaration);
      expect(result.ok).toBe(false);
      if (!result.ok)
        expect(result.failure.diagnostics).toEqual(
          expect.arrayContaining([expect.objectContaining({ code: "IDB_LIST_INDEX" })])
        );
    }
  });

  it("preserves empty-list defaults through the actual emission canonicalizer", () => {
    const built = contract("String[]", { values: [] });
    const serializer = idbTargetControl.contractSerializer;
    const emitted = canonicalizeContractToObject(built, {
      serializeContract: serializer.serializeContract,
      ...(serializer.shouldPreserveEmpty ? { shouldPreserveEmpty: serializer.shouldPreserveEmpty } : {}),
    });
    expect(emitted).toMatchObject({
      execution: { mutations: { defaults: [{ onCreate: { params: { value: [] } } }] } },
    });
  });

  it("requires an explicit transform unless the added list declares []", () => {
    const from = contract();
    expect(operations(from, contract("String[]"))).toMatchObject([
      { kind: "transformRecords", fields: { values: { kind: "placeholder", slot: "Sample.values" } } },
    ]);
    expect(operations(from, contract("String[]", { values: [] }))).toMatchObject([
      { kind: "transformRecords", fields: { values: { kind: "defaultIfMissing", value: [] } } },
    ]);
  });

  it("changes storage identity on add, remove and retype, but not on a default change", () => {
    const plain = contract("String[]");
    expect(plain.storage.storageHash).not.toBe(contract().storage.storageHash);
    expect(plain.storage.storageHash).not.toBe(contract("Int[]").storage.storageHash);
    expect(plain.storage.storageHash).toBe(contract("String[]", { values: [] }).storage.storageHash);
    expect(operations(plain, contract("Int[]"))).toMatchObject([
      { kind: "transformRecords", fields: { values: { kind: "placeholder" } } },
    ]);
    expect(operations(plain, contract())).toMatchObject([{ kind: "transformRecords", removeFields: ["values"] }]);
  });
});
