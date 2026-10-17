import { describe, expect, it } from "vitest";
import type { ContractField, ContractWithDomain } from "@prisma/orm-framework/contract/types";
import { absentAsNull, validateRecord } from "../src/exports/runtime";

function field(nullable: boolean): ContractField {
  return { type: { kind: "scalar", codecId: "idb/string@1" }, nullable };
}

const contract: ContractWithDomain = {
  domain: {
    namespaces: {
      default: {
        models: {
          Item: {
            fields: { id: field(false), name: field(false), nickname: field(true), note: field(true) },
            relations: {},
            storage: { keyPath: "id" },
          },
        },
      },
    },
  },
};

describe("absentAsNull", () => {
  const normalize = absentAsNull(contract, "Item");

  it("fills each absent nullable field with null", () => {
    expect(normalize({ id: "a", name: "A" })).toEqual({ id: "a", name: "A", nickname: null, note: null });
  });

  it("fills a nullable field stored as undefined", () => {
    expect(normalize({ id: "a", name: "A", nickname: undefined, note: "n" })).toEqual({
      id: "a",
      name: "A",
      nickname: null,
      note: "n",
    });
  });

  it("returns the same object when no nullable field is missing", () => {
    const record = { id: "a", name: "A", nickname: "Al", note: null };
    expect(normalize(record)).toBe(record);
  });

  it("copies instead of mutating the stored record", () => {
    const record = { id: "a", name: "A" };
    normalize(record);
    expect(record).toEqual({ id: "a", name: "A" });
  });

  it("leaves a missing required field missing, so validateRecord still rejects it", () => {
    expect(normalize({ id: "a" })).toEqual({ id: "a", nickname: null, note: null });
    expect(validateRecord(contract, "Item", normalize({ id: "a" })).ok).toBe(false);
  });

  it("makes a record stored without nullable fields pass validateRecord", () => {
    expect(validateRecord(contract, "Item", { id: "a", name: "A" }).ok).toBe(false);
    expect(validateRecord(contract, "Item", normalize({ id: "a", name: "A" }))).toEqual({ ok: true });
  });

  it("fills a nullable field named like an Object.prototype member", () => {
    const protoContract: ContractWithDomain = {
      domain: {
        namespaces: {
          default: {
            models: {
              Item: {
                fields: { id: field(false), toString: field(true) },
                relations: {},
                storage: { keyPath: "id" },
              },
            },
          },
        },
      },
    };
    expect(absentAsNull(protoContract, "Item")({ id: "a" })).toEqual({ id: "a", toString: null });
  });

  it("builds one normalizer per model", () => {
    expect(absentAsNull(contract, "Item")).toBe(normalize);
  });

  it("rejects an unknown model", () => {
    expect(() => absentAsNull(contract, "Missing")).toThrow('Unknown model "Missing"');
  });
});

const embeddedContract: ContractWithDomain = {
  domain: {
    namespaces: {
      default: {
        valueObjects: {
          Profile: { fields: { label: field(false), nickname: field(true) } },
          Other: { fields: { title: field(false), note: field(true) } },
          Wrapper: {
            fields: { profile: { type: { kind: "valueObject", name: "Profile" }, nullable: false } },
          },
        },
        models: {
          Item: {
            fields: {
              id: field(false),
              profile: { type: { kind: "valueObject", name: "Profile" }, nullable: true },
              profiles: {
                type: { kind: "valueObject", name: "Profile" },
                nullable: true,
                many: { elementNullable: false },
              },
              dictionary: { type: { kind: "valueObject", name: "Wrapper" }, nullable: false, dict: true },
              json: { type: { kind: "scalar", codecId: "idb/json@1" }, nullable: false },
            },
            relations: {},
            storage: { keyPath: "id" },
          },
        },
      },
    },
  },
};

describe("embedded absentAsNull", () => {
  const normalize = absentAsNull(embeddedContract, "Item");
  const complete = {
    id: "a",
    profile: null,
    profiles: null,
    dictionary: {},
    json: { label: "raw" },
  };

  it("fills nested objects, list elements and dictionaries", () => {
    const stored = {
      ...complete,
      profile: { label: "A" },
      profiles: [{ label: "B" }, { label: "C", nickname: "known" }],
      dictionary: { a: { profile: { label: "D" } } },
    };
    const read = normalize(stored);
    expect(read).toEqual({
      ...stored,
      profile: { label: "A", nickname: null },
      profiles: [
        { label: "B", nickname: null },
        { label: "C", nickname: "known" },
      ],
      dictionary: { a: { profile: { label: "D", nickname: null } } },
    });
    expect(validateRecord(embeddedContract, "Item", read)).toEqual({ ok: true });
    expect(validateRecord(embeddedContract, "Item", stored).ok).toBe(false);
    expect(stored.profile).toEqual({ label: "A" });
    expect(stored.profiles[0]).toEqual({ label: "B" });
    expect(stored.dictionary.a.profile).toEqual({ label: "D" });
    expect(read["json"]).toBe(stored.json);
    expect((read["profiles"] as unknown[])[1]).toBe(stored.profiles[1]);
  });

  it("rejects union fields before normalizing records", () => {
    const schema = structuredClone(embeddedContract);
    schema.domain.namespaces["default"]!.valueObjects!["Profile"]!.fields["choice"] = {
      nullable: true,
      type: { kind: "union", members: [{ kind: "scalar", codecId: "idb/string@1" }] },
    };
    expect(() => absentAsNull(schema, "Item")).toThrow(
      'Value object "Profile" field "choice" uses a union type, which prisma-idb does not support'
    );
  });

  it("preserves null containers and complete record identities", () => {
    expect(normalize(complete)).toBe(complete);
    const stored = { ...complete, profile: { label: "A", nickname: null }, profiles: [] };
    expect(normalize(stored)).toBe(stored);
    expect(normalize({ id: "a", dictionary: {}, json: null })).toEqual({ ...complete, json: null });
  });

  it("does not repair invalid required fields, containers, or null elements", () => {
    for (const patch of [{ profile: {} }, { profiles: [null] }, { profiles: "wrong" }]) {
      expect(validateRecord(embeddedContract, "Item", normalize({ ...complete, ...patch })).ok).toBe(false);
    }
  });
});
