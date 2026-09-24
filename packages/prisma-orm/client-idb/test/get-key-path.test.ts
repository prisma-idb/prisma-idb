import { describe, expect, it } from "vitest";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import idbFamilyPack from "@prisma-idb/family-idb/pack";
import idbTargetPack from "@prisma-idb/target-idb/pack";
import { getKeyPath } from "../src/exports/orm";

const contract = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  models: {
    User: { store: "users", key: "userId", fields: { userId: "String" } },
    Membership: {
      store: "memberships",
      key: ["orgId", "userId"],
      fields: { orgId: "String", userId: "String" },
    },
  },
});

describe("getKeyPath", () => {
  it("returns a single-field key as a string, even when it isn't named id", () => {
    expect(getKeyPath(contract, "User")).toBe("userId");
  });

  it("returns a compound key as an ordered array", () => {
    expect(getKeyPath(contract, "Membership")).toEqual(["orgId", "userId"]);
  });

  it("throws for an unknown model instead of guessing a key name", () => {
    expect(() => getKeyPath(contract, "Nope")).toThrow('Model "Nope" has no storage.keyPath');
  });

  it("throws when a model's storage has no keyPath", () => {
    const broken = structuredClone(contract) as typeof contract;
    const models = (broken.domain as unknown as { namespaces: Record<string, { models: Record<string, unknown> }> })
      .namespaces;
    const ns = Object.values(models)[0]!;
    (ns.models["User"] as { storage: Record<string, unknown> }).storage = {};
    expect(() => getKeyPath(broken, "User")).toThrow('Model "User" has no storage.keyPath');
  });
});
