import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { buildSymbolTable } from "@prisma/orm-framework/psl-parser";
import { parse } from "@prisma/orm-framework/psl-parser/syntax";
import { interpretPslDocumentToIdbContract } from "@prisma-idb/family-idb/contract-psl";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import idbFamilyPack from "@prisma-idb/family-idb/pack";
import idbTargetPack from "@prisma-idb/target-idb/pack";
import type { IdbContract } from "@prisma-idb/client-idb/orm";
import { toWireEvent, WireEncodeError } from "../src/core/wire-event";
import type { OutboxEvent } from "../src/types";

const { document, sources } = parse(
  `
  model Asset {
    id String @id
    size BigInt
    at DateTime?
    name String
    toString String
    json Json
    jsons Json[]
  }
`,
  "schema.prisma"
);
const { symbolTable } = buildSymbolTable({ documents: [document], sources, defaultNamespaceId: "__unbound__" });
const parsed = interpretPslDocumentToIdbContract(symbolTable, "schema.prisma");
if (!parsed.ok) throw new Error(JSON.stringify(parsed.failure.diagnostics));
const contract = parsed.value as IdbContract;

const bytesKeyContract = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  models: {
    Blob: { store: "blobs", key: "id", fields: { id: "Bytes" } },
    Compound: { store: "compound", key: ["name", "id"], fields: { name: "String", id: "Bytes" } },
  },
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

  it("encodes ArrayBuffer keys from IndexedDB, including compound range bounds", () => {
    const lower = new Uint8Array([1]);
    const upper = new Uint8Array([9]);
    const range = IDBKeyRange.bound(lower, upper, false, true);
    expect(range.lower).toBeInstanceOf(ArrayBuffer);
    expect(toWireEvent(bytesKeyContract, event("Blob", "delete", { key: range.lower })).payload).toEqual({
      key: "AQ==",
    });
    const { lower: lo, upper: hi, lowerOpen, upperOpen } = range;
    expect(
      toWireEvent(bytesKeyContract, event("Blob", "delete", { key: { lower: lo, upper: hi, lowerOpen, upperOpen } }))
        .payload
    ).toEqual({
      key: { lower: "AQ==", upper: "CQ==", lowerOpen: false, upperOpen: true },
    });
    const compoundRange = IDBKeyRange.bound(["a", lower], ["b", upper]);
    const compoundKey = { lower: compoundRange.lower, upper: compoundRange.upper };
    expect(toWireEvent(bytesKeyContract, event("Compound", "delete", { key: compoundKey })).payload).toEqual({
      key: { lower: ["a", "AQ=="], upper: ["b", "CQ=="] },
    });
    const view = new DataView(new Uint8Array([0, 1, 2]).buffer, 1, 1);
    expect(toWireEvent(bytesKeyContract, event("Blob", "delete", { key: view })).payload).toEqual({ key: "AQ==" });
  });

  it("leaves an omitted toString field out of a sparse patch", () => {
    expect(toWireEvent(contract, event("Asset", "update", { key: "a", patch: { name: "new" } })).payload).toEqual({
      key: "a",
      patch: { name: "new" },
    });
  });

  it.each([
    ["invalid Date", new Date(NaN)],
    ["Date", new Date(0)],
    ["BigInt", 1n],
    ["Bytes", new Uint8Array([1])],
    ["undefined", undefined],
    ["infinity", Infinity],
  ])("refuses nested %s in Json fields and list elements", (_name, value) => {
    for (const patch of [{ json: { at: value } }, { jsons: [{ at: value }] }]) {
      expect(() => toWireEvent(contract, event("Asset", "update", { key: "a", patch }))).toThrow(
        /contains a value that cannot be represented as JSON/
      );
    }
  });

  it("refuses a bigint or binary value in an unknown model's payload instead of letting JSON.stringify mangle it", () => {
    expect(() => toWireEvent(contract, event("Gone", "create", { id: "a", size: 5n }))).toThrow(WireEncodeError);
    expect(() =>
      toWireEvent(contract, event("Gone", "update", { key: "a", patch: { raw: [new Uint8Array(1)] } }))
    ).toThrow(WireEncodeError);
    expect(() => toWireEvent(contract, event("Gone", "create", { id: "a", size: new ArrayBuffer(1) }))).toThrow(
      WireEncodeError
    );
  });

  it("refuses a bigint in a field the model does not declare", () => {
    expect(() => toWireEvent(contract, event("Asset", "create", { id: "a", extra: 1n }))).toThrow(WireEncodeError);
  });
});
