/**
 * A record below a tenant root with an Int key reaches the root's key as a number, while the
 * scope key is text. Authorization must still match them, or every write below such a root
 * is refused.
 */
import { describe, expect, it } from "vitest";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import idbFamilyPack from "@prisma-idb/family-idb/pack";
import idbTargetPack from "@prisma-idb/target-idb/pack";
import { createSyncServer, type SyncServerContract } from "@prisma-idb/sync-server";
import { checkAuthorization, type RowReader } from "../src/core/authorization";

const contract = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  models: {
    Tenant: {
      store: "tenants",
      key: "id",
      fields: { id: "Int" },
      relations: { projects: { to: "Project", cardinality: "1:N", on: { local: ["id"], target: ["tenantId"] } } },
    },
    Project: {
      store: "projects",
      key: "id",
      fields: { id: "String", tenantId: "Int" },
      relations: { tenant: { to: "Tenant", cardinality: "N:1", on: { local: ["tenantId"], target: ["id"] } } },
    },
  },
}) as unknown as SyncServerContract;

/** Reads rows from an in-memory table, standing in for the database. */
const readRow: RowReader = async (model, key) => (model === "Tenant" && key === 7 ? { id: 7 } : null);

describe("authorization below a tenant root with an Int key", () => {
  const server = createSyncServer({ contract, clientContract: contract, rootModel: "Tenant" });
  const authorize = async (scopeKey: string) => {
    const row = { id: "p1", tenantId: 7 };
    const [result] = server.validatePush(
      [{ id: "e1", model: "Project", operation: "update", payload: row, wireKey: "p1" }],
      { scopeKey }
    );
    if (!result?.check) throw new Error("validatePush returned no ownership check");
    return checkAuthorization(readRow, contract, "Project", result.check, row);
  };

  it("authorizes a child whose root key spells the scope", async () => {
    expect(await authorize("7")).toBe(true);
  });

  it("refuses a child of another root, or a scope that spells the key differently", async () => {
    expect(await authorize("8")).toBe(false);
    expect(await authorize("7.0")).toBe(false);
  });
});
