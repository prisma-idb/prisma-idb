import { describe, expect, it } from "vitest";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import idbFamilyPack from "@prisma-idb/family-idb/pack";
import idbTargetPack from "@prisma-idb/target-idb/pack";
import type { IdbContract } from "@prisma-idb/client-idb/orm";
import { toWireEvent, WireEncodeError } from "../src/core/wire-event";
import type { OutboxEvent } from "../src/types";

const contract = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  models: { Asset: { store: "assets", key: "id", fields: { id: "String", size: "BigInt", at: "DateTime?" } } },
}) as unknown as IdbContract;

function event(entityType: string, operation: string, payload: unknown): OutboxEvent {
  return {
    id: "e1",
    entityType,
    operation,
    payload,
    createdAt: new Date(0),
    synced: false,
    syncedAt: null,
    lastAttemptedAt: null,
    tries: 0,
    lastError: null,
    migrationError: null,
    retryable: true,
    versionMetaId: null,
  };
}

describe("toWireEvent", () => {
  it("encodes a create's BigInt", () => {
    expect(toWireEvent(contract, event("Asset", "create", { id: "a", size: 5n })).payload).toEqual({
      id: "a",
      size: "5",
    });
  });

  it.each([undefined, null, {}])(
    "throws a TypeError for the contract %j instead of sending unencoded values",
    (bad) => {
      expect(() => toWireEvent(bad as unknown as IdbContract, event("Asset", "create", { id: "a", size: 5n }))).toThrow(
        TypeError
      );
    }
  );

  it("throws a WireEncodeError that keeps the codec's error for an invalid date", () => {
    let failure: unknown;
    try {
      toWireEvent(contract, event("Asset", "create", { id: "a", size: 5n, at: new Date(NaN) }));
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(WireEncodeError);
    expect((failure as WireEncodeError).cause).toBeInstanceOf(Error);
    expect((failure as WireEncodeError).message).toContain('create event for "Asset"');
  });

  it("also wraps an invalid date in an update's patch", () => {
    expect(() => toWireEvent(contract, event("Asset", "update", { key: "a", patch: { at: new Date(NaN) } }))).toThrow(
      WireEncodeError
    );
  });

  it("passes an event for a model the contract no longer has through unchanged", () => {
    const unknownModel = event("Gone", "create", { id: "a" });
    expect(toWireEvent(contract, unknownModel)).toBe(unknownModel);
  });
});
