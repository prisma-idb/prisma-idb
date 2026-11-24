import type { ContractField, ContractWithDomain } from "@prisma/orm-framework/contract/types";
import { describe, expect, it } from "vitest";
import { validateRecord } from "../src/core/validate-record";
import { decodeJsonRecord, encodeJsonRecord } from "../src/core/decode-json-record";

const union: ContractField = {
  nullable: true,
  type: {
    kind: "union",
    members: [
      { kind: "scalar", codecId: "idb/date@1" },
      { kind: "scalar", codecId: "idb/bigint@1" },
      { kind: "scalar", codecId: "idb/bytes@1" },
    ],
  },
};
const contract: ContractWithDomain = {
  storage: { namespaces: {} },
  domain: { namespaces: { default: { models: { Item: { fields: { choice: union }, relations: {}, storage: {} } } } } },
};

describe("decodeJsonRecord", () => {
  it.each(["2026-01-01T00:00:00.000Z", "42", "AQ==", null, undefined])(
    "rejects a union field instead of passing through %s",
    (choice) => {
      expect(() => decodeJsonRecord(contract, "Item", { choice })).toThrow(
        'Model "Item" field "choice" uses a union type, which prisma-idb does not support'
      );
    }
  );
  it("rejects omitted union fields and empty union containers", () => {
    expect(() => decodeJsonRecord(contract, "Item", {})).toThrow(/field "choice" uses a union type/);
    for (const extra of [{ many: { elementNullable: false } }, { dict: true }] as const) {
      const nested: ContractWithDomain = {
        storage: {
          namespaces: {
            default: {
              id: "default",
              entries: { valueObject: { Details: { fields: { choice: { ...union, ...extra } } } } },
            },
          },
        },
        domain: {
          namespaces: {
            default: {
              models: {
                Item: {
                  fields: {
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
                  relations: {},
                  storage: {},
                },
              },
            },
          },
        },
      };
      expect(() => decodeJsonRecord(nested, "Item", { details: { choice: "many" in extra ? [] : {} } })).toThrow(
        'Value object "Details" field "choice" uses a union type, which prisma-idb does not support'
      );
    }
  });
});

describe("encodeJsonRecord", () => {
  const scalar = (codecId: string): ContractField => ({ nullable: true, type: { kind: "scalar", codecId } });
  const typed: ContractWithDomain = {
    storage: { namespaces: {} },
    domain: {
      namespaces: {
        default: {
          models: {
            Asset: {
              fields: {
                id: scalar("idb/bytes@1"),
                size: scalar("idb/bigint@1"),
                at: scalar("idb/date@1"),
                toString: scalar("idb/string@1"),
                name: scalar("idb/string@1"),
                sizes: { ...scalar("idb/bigint@1"), many: { elementNullable: true } },
              },
              relations: {},
              storage: {},
            },
          },
        },
      },
    },
  };

  it("leaves inherited fields out and still processes fields explicitly supplied in a patch", () => {
    const sparse = { name: "new" };
    expect(validateRecord(typed, "Asset", sparse, { partial: true })).toEqual({ ok: true });
    expect(Object.hasOwn(encodeJsonRecord(typed, "Asset", sparse), "toString")).toBe(false);
    expect(Object.hasOwn(decodeJsonRecord(typed, "Asset", sparse), "toString")).toBe(false);
    const present = { toString: "title" };
    expect(encodeJsonRecord(typed, "Asset", present)).toEqual(present);
    expect(decodeJsonRecord(typed, "Asset", present)).toEqual(present);
  });

  it("round-trips bigint, bytes, dates and list elements through JSON", () => {
    const record = {
      id: new Uint8Array([1, 2, 255]),
      size: 9007199254740993n,
      at: new Date("2026-01-01T00:00:00.000Z"),
      sizes: [1n, null],
      extra: "kept",
    };
    const wire = JSON.parse(JSON.stringify(encodeJsonRecord(typed, "Asset", record))) as Record<string, unknown>;
    expect(wire).toEqual({
      id: "AQL/",
      size: "9007199254740993",
      at: "2026-01-01T00:00:00.000Z",
      sizes: ["1", null],
      extra: "kept",
    });
    expect(decodeJsonRecord(typed, "Asset", wire)).toEqual(record);
  });
});
