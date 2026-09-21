/**
 * Tests for `createIdbFamilyInstance`.
 *
 * The CLI-side methods (`verify`, `sign`, `readMarker`, `readAllMarkers`,
 * `introspect`) refuse with structured envelopes — IndexedDB is a
 * browser API, so the Node-side CLI has no live database to read or
 * write. The active surface is `deserializeContract` and `verifySchema`,
 * both pure.
 */

import { VERIFY_CODE_TARGET_MISMATCH } from "@prisma/orm-framework/components/control";
import { describe, expect, it } from "vitest";
import { createIdbFamilyInstance } from "../src/core/control-instance";
import { createRawIdbContract } from "./_raw-contract";

/** Build a raw contract object with the given IDB stores. */
function rawContract(
  stores: Record<
    string,
    { keyPath: string; autoIncrement?: boolean; indexes?: Record<string, { keyPath: string; unique: boolean }> }
  >
) {
  return createRawIdbContract(stores);
}

const REFUSAL_CODE = "IDB-CLI-UNSUPPORTED";

// A driver placeholder. None of the IDB CLI methods read it after the refit
// — they short-circuit before touching the driver.
const driver = {} as never;

describe("createIdbFamilyInstance", () => {
  const instance = createIdbFamilyInstance({} as never);

  // ── Active (pure) methods ───────────────────────────────────────────────

  it("deserializeContract accepts a valid IDB contract", () => {
    const contract = rawContract({ users: { keyPath: "id" } });
    expect(() => instance.deserializeContract(contract)).not.toThrow();
  });

  it("verifySchema passes when the in-memory schema matches the contract", () => {
    const contract = rawContract({ users: { keyPath: "id" } });
    const schema = { stores: { users: { keyPath: "id" } } };

    const result = instance.verifySchema({
      contract,
      schema,
      strict: false,
      frameworkComponents: [],
    });
    expect(result.ok).toBe(true);
  });

  // ── CLI refusal surface ─────────────────────────────────────────────────

  it("verify returns structured refusal for valid IDB target", async () => {
    const contract = rawContract({ users: { keyPath: "id" } });
    const result = await instance.verify({
      driver,
      contract,
      expectedTargetId: "idb",
      contractPath: "/contract.json",
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe(REFUSAL_CODE);
    expect(result.summary).toContain("cannot be verified from the CLI");
    expect(result.summary).toContain("only exists in the browser");
  });

  it("verify still surfaces TARGET_MISMATCH before refusing", async () => {
    const contract = rawContract({ users: { keyPath: "id" } });
    const result = await instance.verify({
      driver,
      contract,
      expectedTargetId: "postgres",
      contractPath: "/contract.json",
    });
    expect(result.ok).toBe(false);
    // Target-mismatch must win over the IDB refusal so configs that point
    // at the wrong target see the structural error first.
    expect(result.code).toBe(VERIFY_CODE_TARGET_MISMATCH);
  });

  it("sign returns structured refusal", async () => {
    const contract = rawContract({ users: { keyPath: "id" } });
    const result = await instance.sign({
      driver,
      contract,
      contractPath: "/contract.json",
    });
    expect(result.ok).toBe(false);
    // SignDatabaseResult has no top-level `code` field (unlike
    // VerifyDatabaseResult); the refusal lives in the summary text.
    expect(result.summary).toContain("cannot be signed from the CLI");
    expect(result.summary).toContain("only exists in the browser");
    // marker is required by the type — refusal carries an "untouched" record.
    expect(result.marker.created).toBe(false);
    expect(result.marker.updated).toBe(false);
  });

  it("readMarker returns null (no marker queryable from CLI)", async () => {
    const marker = await instance.readMarker({ driver, space: "app" });
    expect(marker).toBeNull();
  });

  it("readAllMarkers returns an empty map", async () => {
    const markers = await instance.readAllMarkers({ driver });
    expect(markers.size).toBe(0);
  });

  it("introspect returns an empty schema (live DB not reachable)", async () => {
    const schema = await instance.introspect({ driver });
    expect(schema.stores).toEqual({});
  });
});
