import type { ContractField, ContractWithDomain } from "@prisma/orm-framework/contract/types";
import { describe, expect, it } from "vitest";
import { decodeJsonRecord } from "../src/core/decode-json-record";

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
const domain: ContractWithDomain["domain"] = {
  namespaces: {
    default: {
      models: { Item: { fields: { choice: union }, relations: {}, storage: {} } },
      valueObjects: { Details: { fields: { choice: union } } },
    },
  },
};

describe("decodeJsonRecord", () => {
  it.each(["2026-01-01T00:00:00.000Z", "42", "AQ==", null, undefined])(
    "rejects a union field instead of passing through %s",
    (choice) => {
      expect(() => decodeJsonRecord(domain, "Item", { choice })).toThrow(
        'Model "Item" field "choice" uses a union type, which prisma-idb does not support'
      );
    }
  );
  it("rejects omitted union fields and empty union containers", () => {
    expect(() => decodeJsonRecord(domain, "Item", {})).toThrow(/field "choice" uses a union type/);
    for (const extra of [{ many: { elementNullable: false } }, { dict: true }] as const) {
      const nestedDomain: ContractWithDomain["domain"] = {
        namespaces: {
          default: {
            models: {
              Item: {
                fields: { details: { nullable: false, type: { kind: "valueObject", name: "Details" } } },
                relations: {},
                storage: {},
              },
            },
            valueObjects: { Details: { fields: { choice: { ...union, ...extra } } } },
          },
        },
      };
      expect(() => decodeJsonRecord(nestedDomain, "Item", { details: { choice: "many" in extra ? [] : {} } })).toThrow(
        'Value object "Details" field "choice" uses a union type, which prisma-idb does not support'
      );
    }
  });
});
