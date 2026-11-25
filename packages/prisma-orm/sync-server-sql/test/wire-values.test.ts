import { describe, expect, it } from "vitest";
import { encodeWireKey, encodeWireValues, reviveWireKey, reviveWireValues } from "../src/core/wire-values";
import { testContract } from "./helpers";

describe("encodeWireValues", () => {
  it("encodes top-level BigInt columns and leaves values nested in other fields alone", () => {
    // Revival is top-level only too, so the two stay symmetric: SQL value objects and
    // dicts are JSON columns, which hold no native bigint or bytes.
    const encoded = encodeWireValues(testContract, "BigItem", { id: 11n, name: "a", nested: { n: 1n } });
    expect(encoded).toEqual({ id: "11", name: "a", nested: { n: 1n } });
  });

  it("passes a record of an unknown model through", () => {
    const record = { id: 1n };
    expect(encodeWireValues(testContract, "Gone", record)).toBe(record);
  });
});

describe("Json columns on the wire", () => {
  it("writes negative zero in json and jsonb columns as zero without changing the row", () => {
    const row = { id: "j1", value: { score: -0 }, jsonValue: [-0], optionalValue: -0 };
    expect(encodeWireValues(testContract, "JsonItem", row)).toStrictEqual({
      id: "j1",
      value: { score: 0 },
      jsonValue: [0],
      optionalValue: 0,
    });
    expect(row.value.score).toBe(-0);
  });

  it.each([
    ["Infinity", Infinity],
    ["a Date", new Date(0)],
    ["an undefined member", { note: undefined }],
  ])("refuses %s inside a json or jsonb column", (_name, value) => {
    for (const column of ["value", "jsonValue", "optionalValue"]) {
      expect(() => encodeWireValues(testContract, "JsonItem", { id: "j1", [column]: { at: value } })).toThrow(
        /cannot be represented as JSON/
      );
    }
  });

  it("revives Json values as they are, without treating strings as dates or bytes", () => {
    const data = { id: "j1", value: "2026-01-01T00:00:00.000Z", jsonValue: "AQ==", optionalValue: { n: "1" } };
    expect(reviveWireValues(testContract, "JsonItem", data)).toEqual(data);
  });
});

describe("field names that only Object.prototype has", () => {
  it("passes them through when encoding and reviving a row and a key", () => {
    const row = { id: 11n, constructor: "kept", toString: "kept" };
    expect(encodeWireValues(testContract, "BigItem", row)).toEqual({ ...row, id: "11" });
    expect(reviveWireValues(testContract, "BigItem", { id: "11", constructor: "kept" })).toEqual({
      id: 11n,
      constructor: "kept",
    });
    expect(encodeWireKey(testContract, "BigItem", "toString", 1n)).toBe(1n);
    expect(reviveWireKey(testContract, "BigItem", "toString", "1")).toBe("1");
  });
});
