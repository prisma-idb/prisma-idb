import { describe, expect, it, vi } from "vitest";
import { runInNewContext } from "node:vm";
import type {
  ApplicationDomainNamespace,
  ContractField,
  ContractValueObject,
  ContractWithDomain,
} from "@prisma/orm-framework/contract/types";
import { assertRecordValidator, validateRecord, validateKeyFields, validateKeyPath } from "../src/core/validate-record";
import { idbCodecLookup } from "../src/core/codecs";

function field(codecId: string, extra: Partial<ContractField> = {}): ContractField {
  return { type: { kind: "scalar", codecId }, nullable: false, ...extra };
}
function contract(
  fields: Record<string, ContractField>,
  keyPath: string | string[] = "id",
  {
    valueObjects = {},
    ...namespace
  }: Partial<ApplicationDomainNamespace> & {
    valueObjects?: Record<string, { fields: Record<string, ContractField> }>;
  } = {}
): ContractWithDomain {
  return {
    storage: {
      namespaces: {
        default: { id: "default", entries: { valueObject: valueObjects as Record<string, ContractValueObject> } },
      },
    },
    domain: {
      namespaces: {
        default: {
          models: {
            Item: { fields: { id: field("idb/string@1"), ...fields }, relations: {}, storage: { keyPath } },
          },
          ...namespace,
        },
      },
    },
  };
}

describe("validateRecord", () => {
  const schema = contract({ name: field("idb/string@1") });
  it("requires all fields and rejects wrong native types", () => {
    expect(validateRecord(schema, "Item", { id: "a", name: "ok" })).toEqual({ ok: true });
    for (const record of [{ id: "a" }, { id: "a", name: 3 }, null, [], { id: "a", name: undefined }]) {
      expect(validateRecord(schema, "Item", record).ok).toBe(false);
    }
  });
  it("rejects extra fields without stripping or mutating the record", () => {
    const record = { id: "a", name: "ok", extra: true };
    expect(validateRecord(schema, "Item", record).ok).toBe(false);
    expect(record.extra).toBe(true);
  });
  it("distinguishes missing fields, nullable containers and list elements", () => {
    const schema = contract({
      note: field("idb/string@1", { nullable: true }),
      tags: field("idb/string@1", { many: { elementNullable: false } }),
    });
    expect(validateRecord(schema, "Item", { id: "a", note: null, tags: ["ok"] }).ok).toBe(true);
    for (const record of [
      { id: "a", tags: [] },
      { id: "a", note: 2, tags: [] },
      { id: "a", note: null, tags: "ok" },
      { id: "a", note: null, tags: [null] },
    ])
      expect(validateRecord(schema, "Item", record).ok).toBe(false);
  });
  it("accepts null list elements only when the field allows them", () => {
    const strict = contract({ tags: field("idb/string@1", { many: { elementNullable: false } }) });
    const loose = contract({ tags: field("idb/string@1", { many: { elementNullable: true } }) });
    const record = { id: "a", tags: ["x", null] };
    expect(validateRecord(strict, "Item", record).ok).toBe(false);
    expect(validateRecord(loose, "Item", record)).toEqual({ ok: true });
    expect(validateRecord(loose, "Item", { id: "a", tags: ["x", 2] }).ok).toBe(false);
  });
  it("checks every IDB codec's native representation and int32 bounds", () => {
    const schema = contract({
      count: field("idb/int32@1"),
      score: field("idb/double@1"),
      active: field("idb/bool@1"),
      date: field("idb/date@1"),
      big: field("idb/bigint@1"),
      decimal: field("idb/decimal@1"),
      bytes: field("idb/bytes@1"),
      json: field("idb/json@1"),
    });
    const valid = {
      id: "a",
      count: 1,
      score: 1.5,
      active: true,
      date: new Date(),
      big: 1n,
      decimal: "1.25",
      bytes: new Uint8Array([1]),
      json: { nested: [1] },
    };
    expect(validateRecord(schema, "Item", valid).ok).toBe(true);
    for (const patch of [
      { count: 1.5 },
      { count: 2147483648 },
      { score: Infinity },
      { active: "true" },
      { date: "2026-01-01" },
      { date: new Date(NaN) },
      { big: "1" },
      { decimal: 1.25 },
      { bytes: "AQ==" },
    ]) {
      expect(validateRecord(schema, "Item", { ...valid, ...patch }).ok).toBe(false);
    }
  });
  it.each(["idb/json@1", "pg/json@1", "pg/jsonb@1"])("accepts JSON null in a required %s scalar", (codecId) => {
    const schema = contract({ json: field(codecId) });
    const options = {
      codecLookup: {
        targetTypesFor: (id: string) => (id === codecId ? ["unknown"] : idbCodecLookup.targetTypesFor(id)),
      },
    };
    expect(validateRecord(schema, "Item", { id: "a", json: null }, options)).toEqual({ ok: true });
    expect(validateRecord(schema, "Item", { id: "a", json: { nested: null } }, options)).toEqual({ ok: true });
    expect(validateRecord(schema, "Item", { id: "a" }, options).ok).toBe(false);
    expect(validateRecord(schema, "Item", { id: "a", json: undefined }, options).ok).toBe(false);
    for (const extra of [{ many: { elementNullable: false } }, { dict: true }] as const) {
      expect(
        validateRecord(contract({ json: field(codecId, extra) }), "Item", { id: "a", json: null }, options).ok
      ).toBe(false);
    }
  });

  it("accepts only values JSON can represent in a Json field, including list elements", () => {
    const scalar = contract({ json: field("idb/json@1") });
    const list = contract({ json: field("idb/json@1", { many: { elementNullable: false } }) });
    for (const json of [
      { a: [1, "x", true, null, -0, { b: 2 }] },
      { toJSON: "data" },
      Object.assign(Object.create(null), { a: 1 }),
      runInNewContext("({ a: [1] })"),
    ]) {
      expect(validateRecord(scalar, "Item", { id: "a", json }).ok).toBe(true);
    }
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    for (const json of [new Map([["a", 1]]), new Date(0), { at: new Date(0) }, [1n], { n: Number.NaN }, cyclic]) {
      expect(validateRecord(scalar, "Item", { id: "a", json }).ok).toBe(false);
    }
    expect(validateRecord(list, "Item", { id: "a", json: [{ a: 1 }, new Set()] }).ok).toBe(false);
  });

  it.each(["idb/json@1", "pg/json@1", "pg/jsonb@1"])("rejects lossy values for %s", (codecId) => {
    const scalar = contract({ json: field(codecId) });
    const list = contract({ json: field(codecId, { many: { elementNullable: false } }) });
    const codecLookup = {
      targetTypesFor: (id: string) => (id === codecId ? ["unknown"] : idbCodecLookup.targetTypesFor(id)),
    };
    const sparse = [1, 2];
    delete sparse[0];
    const withSerializer = Object.assign([1], { toJSON: "shadow" });
    for (const json of [{ b: undefined }, { a: [[undefined]] }, sparse, withSerializer, { at: new Date(0) }]) {
      for (const [schema, input] of [
        [scalar, json],
        [list, [json]],
      ] as const) {
        expect(validateRecord(schema, "Item", { id: "a", json: input }, { codecLookup })).toMatchObject({
          ok: false,
          issues: [expect.stringMatching(/json.*JSON-compatible value/s)],
        });
      }
    }
    for (const json of [sparse, withSerializer]) {
      expect(validateRecord(list, "Item", { id: "a", json }, { codecLookup }).ok).toBe(false);
    }
  });

  it.each([
    [{ many: { elementNullable: false } }, [1], "0"],
    [{ dict: true }, { own: 1 }, "own"],
  ] as const)("rejects Json container accessors without reading them", (container, value, key) => {
    const json = field("idb/json@1", container);
    const getter = vi.fn(() => {
      Object.defineProperty(value, key, { value: 1, enumerable: true });
      return 1;
    });
    Object.defineProperty(value, key, { get: getter, enumerable: true, configurable: true });
    expect(validateRecord(contract({ json }), "Item", { id: "a", json: value }).ok).toBe(false);
    expect(getter).not.toHaveBeenCalled();
  });

  it("reports invalid null list elements with one short diagnostic", () => {
    const json = field("idb/json@1", { many: { elementNullable: false } });
    const result = validateRecord(contract({ json }), "Item", { id: "a", json: Array(10_000).fill(null) });
    expect(result).toMatchObject({ ok: false, issues: [expect.stringContaining("json")] });
    if (!result.ok) expect(result.issues[0]!.length).toBeLessThan(150);
  });

  it("allows 1000 Json containers and rejects deeper nesting", () => {
    const scalar = contract({ json: field("idb/json@1") });
    const nest = (depth: number, value: unknown = 1) => {
      for (let i = 0; i < depth; i++) value = [value];
      return value;
    };
    expect(validateRecord(scalar, "Item", { id: "a", json: nest(1000) }).ok).toBe(true);
    expect(validateRecord(scalar, "Item", { id: "a", json: nest(1001) }).ok).toBe(false);
    expect(validateRecord(scalar, "Item", { id: "a", json: nest(100_000) }).ok).toBe(false);
    const shared = [1];
    expect(validateRecord(scalar, "Item", { id: "a", json: [nest(999, shared), shared] }).ok).toBe(false);
  });

  it("accepts ordinary shared subtrees and rejects graphs whose JSON representation would be much larger", () => {
    const scalar = contract({ json: field("idb/json@1") });
    let shared: unknown = { a: 1 };
    expect(validateRecord(scalar, "Item", { id: "a", json: [shared, shared] })).toEqual({ ok: true });
    for (let i = 0; i < 30; i++) shared = [shared, shared];
    expect(validateRecord(scalar, "Item", { id: "a", json: shared }).ok).toBe(false);
  });

  it("honors mapped enum values on scalars and lists", () => {
    const status = field("idb/string@1", {
      valueSet: { plane: "domain", namespaceId: "default", entityKind: "enum", entityName: "Status" },
    });
    const schema = contract({ status, statuses: { ...status, many: { elementNullable: false } } }, "id", {
      enum: {
        Status: {
          codecId: "idb/string@1",
          members: [
            { name: "OPEN", value: "open" },
            { name: "DONE", value: "done" },
          ],
        },
      },
    });
    expect(validateRecord(schema, "Item", { id: "a", status: "open", statuses: ["done"] }).ok).toBe(true);
    expect(validateRecord(schema, "Item", { id: "a", status: "OPEN", statuses: [] }).ok).toBe(false);
    expect(validateRecord(schema, "Item", { id: "a", status: "open", statuses: ["other"] }).ok).toBe(false);
  });
  it("validates value objects and dictionaries", () => {
    const schema = contract(
      {
        details: {
          nullable: false,
          type: {
            kind: "valueObject",
            plane: "storage",
            namespaceId: "default",
            entityKind: "valueObject",
            entityName: "Details",
          },
        },
        labels: field("idb/string@1", { dict: true }),
      },
      "id",
      { valueObjects: { Details: { fields: { count: field("idb/int32@1") } } } }
    );
    const valid = { id: "a", details: { count: 1 }, labels: { a: "A" } };
    expect(validateRecord(schema, "Item", valid).ok).toBe(true);
    expect(validateRecord(schema, "Item", { ...valid, details: { count: "bad" } }).ok).toBe(false);
    expect(validateRecord(schema, "Item", { ...valid, labels: { a: 1 } }).ok).toBe(false);
  });
  it("fails closed for union fields, including omitted updates and nullable values", () => {
    const union: ContractField = {
      nullable: true,
      type: {
        kind: "union",
        members: [
          { kind: "scalar", codecId: "idb/string@1" },
          { kind: "scalar", codecId: "idb/bool@1" },
        ],
      },
    };
    const schema = contract({ choice: union });
    const message = 'Model "Item" field "choice" uses a union type, which prisma-idb does not support';
    for (const choice of ["text", true, null]) {
      expect(validateRecord(schema, "Item", { id: "a", choice })).toEqual({ ok: false, issues: [message] });
    }
    expect(validateRecord(schema, "Item", { id: "a" }, { partial: true })).toEqual({ ok: false, issues: [message] });
    expect(() => assertRecordValidator(schema, "Item")).toThrow(message);
    const nested = contract(
      {
        details: {
          nullable: false,
          type: {
            kind: "valueObject",
            plane: "storage",
            namespaceId: "default",
            entityKind: "valueObject",
            entityName: "Details",
          },
        },
      },
      "id",
      {
        valueObjects: { Details: { fields: { choice: union } } },
      }
    );
    expect(validateRecord(nested, "Item", { id: "a", details: { choice: true } })).toEqual({
      ok: false,
      issues: ['Value object "Details" field "choice" uses a union type, which prisma-idb does not support'],
    });
  });
  it("validates partial updates while keeping full records strict", () => {
    expect(validateRecord(schema, "Item", { name: "ok" }, { partial: true }).ok).toBe(true);
    expect(validateRecord(schema, "Item", { name: undefined }, { partial: true }).ok).toBe(false);
    expect(validateRecord(schema, "Item", { name: 2 }, { partial: true }).ok).toBe(false);
    expect(validateRecord(schema, "Item", { id: "a" }, { optionalFields: ["name"] }).ok).toBe(true);
    expect(validateRecord(schema, "Item", { id: "a" }).ok).toBe(false);
  });
  it("caches per contract and lookup, with no cross-contract model collisions", () => {
    const lookup = { targetTypesFor: vi.fn(idbCodecLookup.targetTypesFor) };
    validateRecord(schema, "Item", { id: "a", name: "ok" }, { codecLookup: lookup });
    const calls = lookup.targetTypesFor.mock.calls.length;
    validateRecord(schema, "Item", { id: "b", name: "ok" }, { codecLookup: lookup });
    expect(lookup.targetTypesFor).toHaveBeenCalledTimes(calls);
    expect(validateRecord(contract({ name: field("idb/int32@1") }), "Item", { id: "a", name: "ok" }).ok).toBe(false);
    expect(validateRecord(schema, "Ghost", {}).ok).toBe(false);
    expect(validateRecord(contract({ name: field("custom/unknown@1") }), "Item", { id: "a", name: "ok" }).ok).toBe(
      false
    );
  });
});

describe("key validation", () => {
  const schema = contract({ tenant: field("idb/int32@1") }, ["id", "tenant"]);
  it("checks composite keys' arity, order, types and missing members", () => {
    expect(validateKeyPath(schema, "Item", ["a", 1]).ok).toBe(true);
    for (const key of [["a"], ["a", 1, 2], [1, "a"], ["a", null], "a"])
      expect(validateKeyPath(schema, "Item", key).ok).toBe(false);
    expect(validateKeyFields(schema, "Item", { id: "a", tenant: 1 }, ["id", "tenant"]).ok).toBe(true);
    expect(validateKeyFields(schema, "Item", { id: "a" }, ["id", "tenant"]).ok).toBe(false);
  });
  it("rejects invalid IDB key values even when their codec supports them", () => {
    const schema = contract({ id: field("idb/bool@1") });
    expect(validateKeyPath(schema, "Item", true).ok).toBe(false);
  });
});

describe("assertRecordValidator", () => {
  it("throws for unsupported codecs, including nested value objects", () => {
    const schema = contract(
      {
        details: {
          nullable: false,
          type: {
            kind: "valueObject",
            plane: "storage",
            namespaceId: "default",
            entityKind: "valueObject",
            entityName: "Details",
          },
        },
      },
      "id",
      {
        valueObjects: { Details: { fields: { value: field("custom/object@1") } } },
      }
    );
    expect(() => assertRecordValidator(schema, "Item")).toThrow('No validator for codec "custom/object@1"');
    expect(() => assertRecordValidator(schema, "Ghost")).toThrow('Unknown model "Ghost"');
  });

  it("supports native string-array codecs without weakening element validation", () => {
    const schema = contract({ tags: field("custom/text-array@1") });
    const codecLookup = {
      targetTypesFor: (id: string) => (id === "custom/text-array@1" ? ["string[]"] : idbCodecLookup.targetTypesFor(id)),
    };
    expect(() => assertRecordValidator(schema, "Item", { codecLookup })).not.toThrow();
    expect(validateRecord(schema, "Item", { id: "a", tags: ["ok"] }, { codecLookup }).ok).toBe(true);
    for (const tags of ["ok", [null], [1]])
      expect(validateRecord(schema, "Item", { id: "a", tags }, { codecLookup }).ok).toBe(false);
  });
});
