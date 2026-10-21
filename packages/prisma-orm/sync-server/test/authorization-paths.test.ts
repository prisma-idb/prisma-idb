import { describe, expect, it } from "vitest";
import { createSyncServer, type SyncServerContract } from "../src/exports/server";
import { asNamespaceId, domainModelsAtDefaultNamespace } from "@prisma/orm-framework/contract/types";
import { kanbanClientContract, kanbanContract } from "./helpers";

/** Reads parent authorization requirements through the public push-validation result. */
function referenceChecks(contract: SyncServerContract, model: string) {
  const server = createSyncServer({ contract, clientContract: kanbanClientContract(), rootModel: "User" });
  const [result] = server.validatePush(
    [
      {
        id: "e1",
        model,
        operation: "create",
        payload: model === "User" ? { id: "u1", name: "Ann" } : { id: "u1", authorId: "u1", todoId: null },
        wireKey: "u1",
      },
    ],
    { scopeKey: "u1" }
  );
  if (!result) throw new Error("Missing validation result");
  expect(result.check.kind).toBe(model === "User" ? "root" : "scoped");
  return result.check.kind === "scoped" ? (result.check.parentReferences ?? []) : [];
}

describe("validatePush parent references", () => {
  it("derives independent parents and FK nullability from the full contract", () => {
    const contract = kanbanContract();
    expect(referenceChecks(contract, "Comment")).toEqual([
      { relation: "author", localField: "authorId", nullable: false, paths: [["author"]] },
      { relation: "todo", localField: "todoId", nullable: true, paths: [["todo", "board", "owner"]] },
    ]);
  });

  it("groups alternate routes through the same parent", () => {
    const contract = kanbanContract();
    const todo = domainModelsAtDefaultNamespace(contract.domain)["Todo"]!;
    todo.fields["authorId"] = { nullable: true, type: { kind: "scalar", codecId: "idb/string@1" } };
    todo.relations["author"] = {
      cardinality: "N:1",
      nullable: true,
      to: { model: "User", namespace: asNamespaceId("public") },
      on: { localFields: ["authorId"], targetFields: ["id"] },
    };
    expect(referenceChecks(contract, "Comment")).toEqual([
      { relation: "author", localField: "authorId", nullable: false, paths: [["author"]] },
      {
        relation: "todo",
        localField: "todoId",
        nullable: true,
        paths: [
          ["todo", "author"],
          ["todo", "board", "owner"],
        ],
      },
    ]);
  });

  it.each([
    { localFields: ["ownerId", "id"], targetFields: ["id", "name"] },
    { localFields: ["ownerId"], targetFields: ["name"] },
    { localFields: [], targetFields: [] },
    { localFields: ["missing"], targetFields: ["id"] },
  ])("rejects unsupported FK metadata, including intermediate joins: %j", (on) => {
    const contract = kanbanContract();
    const board = domainModelsAtDefaultNamespace(contract.domain)["Board"]!;
    board.relations["owner"] = {
      cardinality: "N:1",
      nullable: false,
      to: { model: "User", namespace: asNamespaceId("public") },
      on,
    };
    expect(() => referenceChecks(contract, "Comment")).toThrow(/Board.owner.*single-field FK/);
  });

  it("excludes global parents and inverse collections, and returns no checks for the root", () => {
    const contract = kanbanContract();
    const models = domainModelsAtDefaultNamespace(contract.domain);
    models["Comment"]!.fields["auditId"] = { nullable: true, type: { kind: "scalar", codecId: "idb/string@1" } };
    models["Comment"]!.relations["audit"] = {
      cardinality: "N:1",
      nullable: true,
      to: { model: "AuditLog", namespace: asNamespaceId("public") },
      on: { localFields: ["auditId"], targetFields: ["id"] },
    };
    models["User"]!.relations["comments"] = {
      cardinality: "1:N",
      to: { model: "Comment", namespace: asNamespaceId("public") },
      on: { localFields: ["id"], targetFields: ["authorId"] },
    };
    expect(referenceChecks(contract, "Comment").map(({ relation }) => relation)).toEqual(["author", "todo"]);
    expect(referenceChecks(contract, "User")).toEqual([]);
  });
});
