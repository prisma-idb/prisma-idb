import { describe, expect, it } from "vitest";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import idbFamilyPack from "@prisma-idb/family-idb/pack";
import idbTargetPack from "@prisma-idb/target-idb/pack";
import { createSyncServer, sameScopeKey } from "../src/exports/server";
import type { SyncServerContract } from "../src/core/ownership-dag";

describe("a tenant root with an Int key", () => {
  const contract = defineContract({
    family: idbFamilyPack,
    target: idbTargetPack,
    models: { Tenant: { store: "tenants", key: "id", fields: { id: "Int", name: "String" } } },
  }) as unknown as SyncServerContract;
  const server = createSyncServer({ contract, clientContract: contract, rootModel: "Tenant" });

  it("authorizes the scope that spells its key, and only that one", () => {
    const push = (scopeKey: string) =>
      server.validatePush(
        [{ id: "e1", model: "Tenant", operation: "update", payload: { id: 7, name: "Acme" }, wireKey: 7 }],
        { scopeKey }
      )[0]?.check;
    expect(push("7")).toMatchObject({ kind: "root", authorized: true });
    expect(push("8")).toMatchObject({ kind: "root", authorized: false });
    expect(push("7.0")).toMatchObject({ kind: "root", authorized: false });
  });

  it("compares a numeric root key with the scope as text", () => {
    expect(sameScopeKey(7, "7")).toBe(true);
    expect(sameScopeKey("7", "7")).toBe(true);
    expect(sameScopeKey(Number.NaN, "NaN")).toBe(false);
    expect(sameScopeKey(Number.POSITIVE_INFINITY, "Infinity")).toBe(false);
  });

  it("spells a number the way String() does", () => {
    expect(sameScopeKey(-0, "0")).toBe(true);
    expect(sameScopeKey(1.5, "1.5")).toBe(true);
    expect(sameScopeKey(1e21, "1e+21")).toBe(true);
    expect(sameScopeKey(1e21, "1000000000000000000000")).toBe(false);
  });

  it("matches a bigint root key by its digits", () => {
    expect(sameScopeKey(9007199254740993n, "9007199254740993")).toBe(true);
    expect(sameScopeKey(9007199254740993n, "9007199254740992")).toBe(false);
    // On the wire a BigInt key is already a digit string.
    expect(sameScopeKey("9007199254740993", "9007199254740993")).toBe(true);
  });
});
