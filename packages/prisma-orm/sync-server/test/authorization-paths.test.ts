import { describe, expect, it } from "vitest";
import { resolveAuthorizationPaths, resolveParentReferenceChecks } from "../src/core/authorization-paths";
import { defaultGetKeyField } from "../src/core/sync-server";
import { asNamespaceId, domainModelsAtDefaultNamespace } from "@prisma/orm-framework/contract/types";
import { kanbanContract } from "./helpers";

describe("resolveAuthorizationPaths", () => {
  it("returns no paths for the root model itself", () => {
    expect(resolveAuthorizationPaths(kanbanContract(), "User", "User")).toEqual([]);
  });

  it("returns the single relation-name chain for a direct child", () => {
    expect(resolveAuthorizationPaths(kanbanContract(), "User", "Board")).toEqual([["owner"]]);
  });

  it("returns a multi-hop chain for a grandchild", () => {
    expect(resolveAuthorizationPaths(kanbanContract(), "User", "Todo")).toEqual([["board", "owner"]]);
  });

  it("returns every path, shortest first, when a model is reachable more than one way", () => {
    const paths = resolveAuthorizationPaths(kanbanContract(), "User", "Comment");

    expect(paths).toEqual([["author"], ["todo", "board", "owner"]]);
  });
});

describe("resolveParentReferenceChecks", () => {
  it("derives independent parents and FK nullability from the full contract", () => {
    const contract = kanbanContract();
    const paths = resolveAuthorizationPaths(contract, "User", "Comment");
    expect(resolveParentReferenceChecks(contract, defaultGetKeyField, "Comment", paths)).toEqual([
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
    const paths = resolveAuthorizationPaths(contract, "User", "Comment");
    expect(resolveParentReferenceChecks(contract, defaultGetKeyField, "Comment", paths)).toEqual([
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
    expect(() =>
      resolveParentReferenceChecks(
        contract,
        defaultGetKeyField,
        "Comment",
        resolveAuthorizationPaths(contract, "User", "Comment")
      )
    ).toThrow(/Board.owner.*single-field FK/);
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
    expect(
      resolveParentReferenceChecks(
        contract,
        defaultGetKeyField,
        "Comment",
        resolveAuthorizationPaths(contract, "User", "Comment")
      ).map(({ relation }) => relation)
    ).toEqual(["author", "todo"]);
    expect(
      resolveParentReferenceChecks(
        contract,
        defaultGetKeyField,
        "User",
        resolveAuthorizationPaths(contract, "User", "User")
      )
    ).toEqual([]);
  });
});
