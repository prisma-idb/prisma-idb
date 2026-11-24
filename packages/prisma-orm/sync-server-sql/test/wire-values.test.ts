import { describe, expect, it } from "vitest";
import { encodeWireValues } from "../src/core/wire-values";
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
