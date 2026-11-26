import { describe, expect, it } from "vitest";
import { createSyncServer } from "../src/exports/server";
import {
  contractWithUnexcludedIsland,
  cyclicContract,
  kanbanClientContract,
  kanbanContract,
  kanbanContractWithIgnored,
} from "./helpers";

describe("createSyncServer ownership graph", () => {
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

  it("refuses events for an @@ignore model and doesn't require it to reach the root", () => {
    const server = createSyncServer({ ...kanbanContractWithIgnored(), rootModel: "User" });
    const [result] = server.validatePush(
      [{ id: "e1", model: "Legacy", operation: "delete", payload: { id: "l1" }, wireKey: "l1" }],
      { scopeKey: "u1" }
    );
    expect(result?.check).toEqual({ kind: "unknown-model" });
  });

  it("starts with an @@ignore model that has no key and refuses its events", () => {
    const server = createSyncServer({ ...kanbanContractWithIgnored(), rootModel: "User" });
    const [result] = server.validatePush(
      [{ id: "e1", model: "Trail", operation: "create", payload: { note: "n", boardId: "b1" }, wireKey: 1 }],
      { scopeKey: "u1" }
    );
    expect(result?.check).toEqual({ kind: "unknown-model" });
  });

  it("counts an @ignore owning relation as an ownership path", () => {
    const server = createSyncServer({ ...kanbanContractWithIgnored(), rootModel: "User" });
    const [result] = server.validatePush(
      [{ id: "e1", model: "Note", operation: "delete", payload: { id: "n1" }, wireKey: "n1" }],
      { scopeKey: "u1" }
    );
    expect(result?.check).toMatchObject({ kind: "scoped" });
  });

  it("throws when rootModel is @@ignore", () => {
    const { contract, clientContract } = kanbanContractWithIgnored();
    expect(() => createSyncServer({ contract, clientContract, rootModel: "Legacy" })).toThrow(
      'Root model "Legacy" is marked @@ignore, so it never syncs and can\'t own synced rows.'
    );
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
