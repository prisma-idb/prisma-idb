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

  it("builds one normalizer per model", () => {
    expect(absentAsNull(contract, "Item")).toBe(normalize);
  });

  it("rejects an unknown model", () => {
    expect(() => absentAsNull(contract, "Missing")).toThrow('Unknown model "Missing"');
  });
});
