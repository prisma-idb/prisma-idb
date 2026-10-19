import { describe, expect, it } from "vitest";
import { createSyncServer } from "../src/exports/server";
import { contractWithUnexcludedIsland, cyclicContract, kanbanClientContract, kanbanContract } from "./helpers";

describe("buildOwnershipDag", () => {
  it("accepts server-only islands but refuses their events", () => {
    const server = createSyncServer({
      contract: kanbanContract(),
      clientContract: kanbanClientContract(),
      rootModel: "User",
    });
    const [result] = server.validatePush(
      [{ id: "hidden", model: "AuditLog", operation: "delete", payload: { id: "a1" }, wireKey: "a1" }],
      { scopeKey: "u1" }
    );
    expect(result?.check).toEqual({ kind: "unknown-model" });
  });

  it("throws when a client model has no path back to root", () => {
    const { contract, clientContract } = contractWithUnexcludedIsland();

    expect(() => createSyncServer({ contract, clientContract, rootModel: "User" })).toThrow(/Tag.*no path/s);
  });

  it("throws when the ownership graph has a cycle", () => {
    const contract = cyclicContract();

    expect(() => createSyncServer({ contract, clientContract: contract, rootModel: "A" })).toThrow(/Cycle detected/);
  });

  it("throws when rootModel is not in the contract", () => {
    expect(() =>
      createSyncServer({ contract: kanbanContract(), clientContract: kanbanClientContract(), rootModel: "Nope" })
    ).toThrow(/Root model "Nope" is not present in the contract/);
  });

  it("throws when rootModel was excluded from the client contract", () => {
    expect(() =>
      createSyncServer({ contract: kanbanContract(), clientContract: kanbanClientContract(), rootModel: "AuditLog" })
    ).toThrow(/Root model "AuditLog" is not present in the client contract/);
  });
});
