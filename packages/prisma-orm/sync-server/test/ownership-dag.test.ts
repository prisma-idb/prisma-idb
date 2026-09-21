import { describe, expect, it } from "vitest";
import { buildOwnershipDag } from "../src/core/ownership-dag";
import { contractWithUnexcludedIsland, cyclicContract, kanbanClientContract, kanbanContract } from "./helpers";

describe("buildOwnershipDag", () => {
  it("builds edges from every N:1 relation, root model included", () => {
    const dag = buildOwnershipDag(kanbanContract(), kanbanClientContract(), "User");

    expect(dag.rootModel).toBe("User");
    expect(dag.edges.get("Board")).toEqual(new Set(["User"]));
    expect(dag.edges.get("Todo")).toEqual(new Set(["Board"]));
    expect(dag.edges.get("Comment")).toEqual(new Set(["Todo", "User"]));
    expect(dag.edges.get("User")).toEqual(new Set());
  });

  it("excludes server-only models from clientModels but keeps them as graph nodes", () => {
    const dag = buildOwnershipDag(kanbanContract(), kanbanClientContract(), "User");

    expect(dag.clientModels.has("AuditLog")).toBe(false);
    expect(dag.edges.has("AuditLog")).toBe(true);
  });

  it("does not require a relation-less server-only model to reach root", () => {
    expect(() => buildOwnershipDag(kanbanContract(), kanbanClientContract(), "User")).not.toThrow();
  });

  it("throws when a client model has no path back to root", () => {
    const { contract, clientContract } = contractWithUnexcludedIsland();

    expect(() => buildOwnershipDag(contract, clientContract, "User")).toThrow(/Tag.*no path/s);
  });

  it("throws when the ownership graph has a cycle", () => {
    const contract = cyclicContract();

    expect(() => buildOwnershipDag(contract, contract, "A")).toThrow(/Cycle detected/);
  });

  it("throws when rootModel is not in the contract", () => {
    expect(() => buildOwnershipDag(kanbanContract(), kanbanClientContract(), "Nope")).toThrow(
      /Root model "Nope" is not present in the contract/
    );
  });

  it("throws when rootModel was excluded from the client contract", () => {
    expect(() => buildOwnershipDag(kanbanContract(), kanbanClientContract(), "AuditLog")).toThrow(
      /Root model "AuditLog" is not present in the client contract/
    );
  });
});
