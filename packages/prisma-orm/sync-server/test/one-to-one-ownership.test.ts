import { describe, expect, it } from "vitest";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import idbFamilyPack from "@prisma-idb/family-idb/pack";
import idbTargetPack from "@prisma-idb/target-idb/pack";
import { createSyncServer, resolveAuthorizationPaths } from "../src/exports/server";
import type { SyncServerContract } from "../src/core/ownership-dag";

/**
 * `Profile.user` is a 1:1 that owns the foreign key `userId`, recorded the way
 * a Prisma 8 SQL contract records it: a table foreign key on `user_id`.
 */
function contract(withForeignKey: boolean): SyncServerContract {
  const built = structuredClone(
    defineContract({
      family: idbFamilyPack,
      target: idbTargetPack,
      models: {
        User: { store: "users", key: "id", fields: { id: "String" } },
        Profile: {
          store: "profiles",
          key: "id",
          fields: { id: "String", userId: "String" },
          relations: { user: { to: "User", cardinality: "1:1", on: { local: ["userId"], target: ["id"] } } },
        },
      },
    })
  ) as unknown as {
    domain: { namespaces: Record<string, { models: Record<string, { storage: Record<string, unknown> }> }> };
    storage: { namespaces: Record<string, unknown> };
  };
  const models = built.domain.namespaces["__unbound__"]!.models;
  models["User"]!.storage = { ...models["User"]!.storage, namespaceId: "public", table: "user", fields: {} };
  models["Profile"]!.storage = {
    ...models["Profile"]!.storage,
    namespaceId: "public",
    table: "profile",
    fields: { userId: { column: "user_id" } },
  };
  built.storage.namespaces["public"] = {
    entries: {
      table: {
        user: { foreignKeys: [] },
        profile: {
          foreignKeys: withForeignKey
            ? [
                {
                  source: { columns: ["user_id"] },
                  target: { namespaceId: "public", tableName: "user", columns: ["id"] },
                },
              ]
            : [],
        },
      },
    },
  };
  return built as unknown as SyncServerContract;
}

describe("a one-to-one foreign key", () => {
  it("carries ownership from the side whose table holds the foreign key", () => {
    const owned = contract(true);
    expect(resolveAuthorizationPaths(owned, "User", "Profile")).toEqual([["user"]]);
    expect(() => createSyncServer({ contract: owned, clientContract: owned, rootModel: "User" })).not.toThrow();
  });

  it("carries nothing from a 1:1 whose table declares no foreign key", () => {
    const unowned = contract(false);
    expect(resolveAuthorizationPaths(unowned, "User", "Profile")).toEqual([]);
    expect(() => createSyncServer({ contract: unowned, clientContract: unowned, rootModel: "User" })).toThrow(
      /Profile.*no path/s
    );
  });
});
