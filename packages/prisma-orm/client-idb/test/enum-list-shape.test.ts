/**
 * Enum list fields keep working when a contract stores list cardinality as an
 * object.
 *
 * Contracts written by older releases mark a list field `many: true`. Newer
 * Prisma 8 releases store `many: { elementNullable: false }` instead. The
 * enum checks and the query planner must treat both shapes as a list.
 */
import { describe, expect, it } from "vitest";
import { buildSymbolTable } from "@prisma/orm-framework/psl-parser";
import { parse } from "@prisma/orm-framework/psl-parser/syntax";
import { interpretPslDocumentToIdbContract } from "@prisma-idb/family-idb/contract-psl";
import { assertEnumValues } from "../src/core/enum-validation";
import { buildCatalog } from "../src/core/planner/catalog";
import type { IdbContract } from "../src/exports/orm";

const SCHEMA = `
  enum Role {
    USER
    ADMIN
  }

  model Member {
    id    String @id
    roles Role[]
  }
`;

/** Parses a PSL schema and interprets it into an IDB contract, throwing the diagnostics when interpretation fails. */
function contractFromPsl(schema: string): IdbContract {
  const { document, sources } = parse(schema, "schema.prisma");
  const { symbolTable } = buildSymbolTable({ documents: [document], sources, pslBlockDescriptors: {} });
  const result = interpretPslDocumentToIdbContract(symbolTable, "schema.prisma");
  if (!result.ok) throw new Error(JSON.stringify(result.failure.diagnostics));
  return result.value as IdbContract;
}

/** Copy of `contract` whose list fields store `many` as `value`. */
function withManyShape(contract: IdbContract, value: unknown): IdbContract {
  const copy = structuredClone(contract) as unknown as IdbContract;
  for (const namespace of Object.values(copy.domain.namespaces)) {
    for (const model of Object.values(namespace.models)) {
      for (const field of Object.values(model.fields) as { many?: unknown }[]) {
        if (field.many !== undefined) field.many = value;
      }
    }
  }
  return copy;
}

const BASE = contractFromPsl(SCHEMA);
const SHAPES: Record<string, unknown> = {
  "boolean (older contracts)": true,
  "object (newer contracts)": { elementNullable: false },
};

describe.each(Object.entries(SHAPES))("enum list field with a `many` of %s", (_label, shape) => {
  const contract = withManyShape(BASE, shape);

  it("accepts an array of declared members", () => {
    expect(() => assertEnumValues(contract, "Member", { roles: ["USER", "ADMIN"] })).not.toThrow();
  });

  it("rejects an undeclared member inside the array", () => {
    expect(() => assertEnumValues(contract, "Member", { roles: ["USER", "OWNER"] })).toThrow(
      /Invalid value "OWNER" for enum field "Member\.roles"/
    );
  });

  it("marks the field as a collection in the query catalog", () => {
    const catalog = buildCatalog(contract, "member", "Member");
    expect(catalog.fields["roles"]?.collection).toBe(true);
    expect(catalog.fields["id"]?.collection).toBe(false);
  });
});
