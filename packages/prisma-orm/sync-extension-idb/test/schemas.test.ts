import { describe, expect, it } from "vitest";
import { logWithRecordSchema, pushResultSchema } from "../src/schemas";

const identity = {
  changelogId: "c1",
  model: "BigItem",
  operation: "update" as const,
  keyPath: "invalid-bigint",
};

describe("pull wire schema", () => {
  it.each([{ id: "invalid-bigint", name: "local" }, null])("preserves existing record logs: %s", (record) => {
    const log = { ...identity, record };
    expect(logWithRecordSchema.parse(JSON.parse(JSON.stringify(log)))).toEqual(log);
  });

  it("retains the server failure marker across JSON and schema parsing", () => {
    const log = { ...identity, validationError: "KEYPATH_VALIDATION_FAILURE" };
    expect(logWithRecordSchema.parse(JSON.parse(JSON.stringify(log)))).toEqual(log);
  });

  it.each([null, { id: "invalid-bigint" }])("rejects a failure marker carrying a record: %s", (record) => {
    expect(
      logWithRecordSchema.safeParse({ ...identity, validationError: "KEYPATH_VALIDATION_FAILURE", record }).success
    ).toBe(false);
  });

  it("rejects missing records without a failure marker and unrecognized failure codes", () => {
    expect(logWithRecordSchema.safeParse(identity).success).toBe(false);
    expect(logWithRecordSchema.safeParse({ ...identity, validationError: "UNKNOWN", record: null }).success).toBe(
      false
    );
  });
});

describe("push result wire schema", () => {
  const failure = { id: "e1", success: false, error: "Failed to apply event e1", retryable: false };

  it.each([{ id: "u1", name: "Alice" }, null])("keeps the server row sent with a rejection: %j", (record) => {
    const result = { ...failure, record };
    expect(pushResultSchema.parse(JSON.parse(JSON.stringify(result)))).toEqual(result);
  });

  it("accepts a result from a server that sends no record", () => {
    expect(pushResultSchema.parse(failure)).toEqual(failure);
  });

  it("rejects a record that is not an object", () => {
    expect(pushResultSchema.safeParse({ ...failure, record: "u1" }).success).toBe(false);
  });
});
