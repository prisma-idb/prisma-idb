import { describe, expect, it, vi } from "vitest";
import type {
  ApplicationDomainNamespace,
  ContractField,
  ContractWithDomain,
} from "@prisma/orm-framework/contract/types";
import { validateRecord, validateKeyFields, validateKeyPath } from "../src/core/validate-record";
import { idbCodecLookup } from "../src/core/codecs";

function field(codecId: string, extra: Partial<ContractField> = {}): ContractField {
  return { type: { kind: "scalar", codecId }, nullable: false, ...extra };
}
function contract(
  fields: Record<string, ContractField>,
  keyPath: string | string[] = "id",
  namespace: Partial<ApplicationDomainNamespace> = {}
): ContractWithDomain {
  return {
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
      tags: field("idb/string@1", { many: true }),
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
  it("honors mapped enum values on scalars and lists", () => {
    const status = field("idb/string@1", {
      valueSet: { plane: "domain", namespaceId: "default", entityKind: "enum", entityName: "Status" },
    });
    const schema = contract({ status, statuses: { ...status, many: true } }, "id", {
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
  it("validates value objects, dictionaries and unions", () => {
    const schema = contract(
      {
        details: { nullable: false, type: { kind: "valueObject", name: "Details" } },
        labels: field("idb/string@1", { dict: true }),
        union: {
          nullable: false,
          type: {
            kind: "union",
            members: [
              { kind: "scalar", codecId: "idb/string@1" },
              { kind: "scalar", codecId: "idb/bool@1" },
            ],
          },
        },
      },
      "id",
      { valueObjects: { Details: { fields: { count: field("idb/int32@1") } } } }
    );
    const valid = { id: "a", details: { count: 1 }, labels: { a: "A" }, union: true };
    expect(validateRecord(schema, "Item", valid).ok).toBe(true);
    expect(validateRecord(schema, "Item", { ...valid, details: { count: "bad" } }).ok).toBe(false);
    expect(validateRecord(schema, "Item", { ...valid, labels: { a: 1 } }).ok).toBe(false);
    expect(validateRecord(schema, "Item", { ...valid, union: 1 }).ok).toBe(false);
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
