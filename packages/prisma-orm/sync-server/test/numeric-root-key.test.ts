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
  });
});
