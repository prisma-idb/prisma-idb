import { describe, expect, it } from "vitest";
import type {
  ApplicationDomainNamespace,
  ContractField,
  ContractWithDomain,
} from "@prisma/orm-framework/contract/types";
import { contractFingerprint } from "../src/core/contract-fingerprint";

function field(codecId: string, extra: Partial<ContractField> = {}): ContractField {
  return { type: { kind: "scalar", codecId }, nullable: false, ...extra };
}
function contract(
  fields: Record<string, ContractField> = {},
  namespace: Partial<ApplicationDomainNamespace> = {},
  storage: Record<string, unknown> = { keyPath: "id" }
): ContractWithDomain {
  return {
    domain: {
      namespaces: {
        default: {
          models: { Item: { fields: { id: field("idb/string@1"), ...fields }, relations: {}, storage } },
          ...namespace,
        },
      },
    },
  };
}

describe("contractFingerprint", () => {
  it("is a SHA-256 hex digest", async () => {
    expect(await contractFingerprint(contract())).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not depend on key order", async () => {
    const a = contract({ name: field("idb/string@1"), age: field("idb/int32@1") });
    const b = contract({ age: field("idb/int32@1"), name: field("idb/string@1") });
    expect(await contractFingerprint(a)).toBe(await contractFingerprint(b));
  });

  it("does not depend on model order", async () => {
    const model = contract().domain.namespaces["default"]!.models["Item"]!;
    const ordered = (...names: string[]): ContractWithDomain => ({
      domain: { namespaces: { default: { models: Object.fromEntries(names.map((name) => [name, model])) } } },
    });
    expect(await contractFingerprint(ordered("A", "B"))).toBe(await contractFingerprint(ordered("B", "A")));
  });

  it("changes when a non-indexed field is added", async () => {
    const before = await contractFingerprint(contract());
    expect(await contractFingerprint(contract({ note: field("idb/string@1") }))).not.toBe(before);
  });

  it("changes when a field's nullability or codec changes", async () => {
    const before = await contractFingerprint(contract({ note: field("idb/string@1") }));
    expect(await contractFingerprint(contract({ note: field("idb/string@1", { nullable: true }) }))).not.toBe(before);
    expect(await contractFingerprint(contract({ note: field("idb/int32@1") }))).not.toBe(before);
  });

  it("changes when an enum gains a member", async () => {
    const withMembers = (...members: string[]) =>
      contract(
        {},
        {
          enum: {
            Status: {
              codecId: "idb/string@1",
              members: members.map((value) => ({ name: value.toUpperCase(), value })),
            },
          },
        }
      );
    expect(await contractFingerprint(withMembers("open"))).not.toBe(
      await contractFingerprint(withMembers("open", "done"))
    );
  });

  it("changes when a value object changes", async () => {
    const withObject = (...fieldNames: string[]) =>
      contract(
        {},
        {
          valueObjects: {
            Address: { fields: Object.fromEntries(fieldNames.map((name) => [name, field("idb/string@1")])) },
          },
        }
      );
    expect(await contractFingerprint(withObject("city"))).not.toBe(
      await contractFingerprint(withObject("city", "zip"))
    );
  });

  it("ignores storage layout, which cannot change how a record decodes", async () => {
    const indexed = contract({}, {}, { keyPath: "id", indexes: [{ name: "byId", keyPath: "id" }] });
    expect(await contractFingerprint(indexed)).toBe(await contractFingerprint(contract()));
  });
});
