import { describe, expect, it } from "vitest";
import { createSyncServer } from "../src/core/sync-server";
import type { SyncServerContract } from "../src/core/ownership-dag";
import { kanbanClientContract, kanbanContract } from "./helpers";

/**
 * Simulates a non-IDB family's storage shape: renames every model's
 * `storage.keyPath` to `storage.pk` (a stand-in for e.g. SQL's
 * `primaryKey.columns` living somewhere entirely different from IDB's flat
 * field). Proves the DAG genuinely only needs `contract.domain` plus an
 * injected `getKeyField` — nothing here is IDB-shaped once that's supplied.
 */
function toNonIdbShapedContract(contract: SyncServerContract): SyncServerContract {
  const clone = JSON.parse(JSON.stringify(contract)) as SyncServerContract;
  for (const namespace of Object.values(clone.domain.namespaces)) {
    for (const model of Object.values(namespace.models)) {
      const storage = model.storage as { keyPath?: unknown; pk?: unknown };
      storage.pk = storage.keyPath;
      delete storage.keyPath;
    }
  }
  return clone;
}

function server() {
  return createSyncServer({ contract: kanbanContract(), clientContract: kanbanClientContract(), rootModel: "User" });
}

describe("createSyncServer", () => {
  it("throws at construction on a broken schema, not per-request", () => {
    expect(() =>
      createSyncServer({ contract: kanbanContract(), clientContract: kanbanClientContract(), rootModel: "Ghost" })
    ).toThrow();
  });

  describe("validatePush", () => {
    it("resolves the root model directly, no paths needed", () => {
      const [result] = server().validatePush(
        [{ id: "e1", model: "User", operation: "update", payload: { id: "user-1", name: "Ada" } }],
        { scopeKey: "user-1" }
      );

      expect(result?.check).toEqual({
        kind: "root",
        keyField: "id",
        key: "user-1",
        scopeKey: "user-1",
        authorized: true,
      });
    });

    it("marks a root-model event unauthorized when the key doesn't match scopeKey", () => {
      const [result] = server().validatePush(
        [{ id: "e1", model: "User", operation: "update", payload: { id: "someone-else", name: "Ada" } }],
        { scopeKey: "user-1" }
      );

      expect(result?.check).toMatchObject({ kind: "root", authorized: false });
    });

    it("resolves a non-root model to every authorization path", () => {
      const [result] = server().validatePush(
        [{ id: "e1", model: "Todo", operation: "create", payload: { id: "todo-1", boardId: "board-1" } }],
        { scopeKey: "user-1" }
      );

      expect(result?.check).toEqual({
        kind: "scoped",
        keyField: "id",
        key: "todo-1",
        rootKeyField: "id",
        scopeKey: "user-1",
        paths: [["board", "owner"]],
      });
    });

    it("resolves all paths for a model reachable more than one way", () => {
      const [result] = server().validatePush(
        [{ id: "e1", model: "Comment", operation: "create", payload: { id: "c1", authorId: "user-1" } }],
        { scopeKey: "user-1" }
      );

      expect(result?.check).toMatchObject({
        kind: "scoped",
        paths: [["author"], ["todo", "board", "owner"]],
      });
    });

    it("rejects an event for a model the client contract never exposes", () => {
      const [result] = server().validatePush(
        [{ id: "e1", model: "AuditLog", operation: "create", payload: { id: "log-1" } }],
        { scopeKey: "user-1" }
      );

      expect(result?.check).toEqual({ kind: "unknown-model" });
    });

    it("rejects an event for a model that doesn't exist at all", () => {
      const [result] = server().validatePush([{ id: "e1", model: "Ghost", operation: "create", payload: {} }], {
        scopeKey: "user-1",
      });

      expect(result?.check).toEqual({ kind: "unknown-model" });
    });

    it("processes every event independently, preserving order", () => {
      const results = server().validatePush(
        [
          { id: "e1", model: "User", operation: "update", payload: { id: "user-1" } },
          { id: "e2", model: "Board", operation: "create", payload: { id: "board-1", ownerId: "user-1" } },
        ],
        { scopeKey: "user-1" }
      );

      expect(results.map((r) => r.eventId)).toEqual(["e1", "e2"]);
    });
  });

  describe("family-agnostic getKeyField", () => {
    it("throws with the default resolver when storage isn't IDB-shaped", () => {
      const contract = toNonIdbShapedContract(kanbanContract());
      const clientContract = toNonIdbShapedContract(kanbanClientContract());
      const syncServer = createSyncServer({ contract, clientContract, rootModel: "User" });

      expect(() =>
        syncServer.validatePush([{ id: "e1", model: "User", operation: "update", payload: { id: "user-1" } }], {
          scopeKey: "user-1",
        })
      ).toThrow(/storage.keyPath/);
    });

    it("works against a non-IDB-shaped contract given a custom getKeyField", () => {
      const contract = toNonIdbShapedContract(kanbanContract());
      const clientContract = toNonIdbShapedContract(kanbanClientContract());

      const syncServer = createSyncServer({
        contract,
        clientContract,
        rootModel: "User",
        getKeyField: (c, modelName) => {
          const models = (
            c.domain.namespaces[Object.keys(c.domain.namespaces)[0]!] as { models: Record<string, unknown> }
          ).models;
          return (models[modelName] as { storage: { pk: string } }).storage.pk;
        },
      });

      const [result] = syncServer.validatePush(
        [{ id: "e1", model: "Todo", operation: "create", payload: { id: "todo-1", boardId: "board-1" } }],
        { scopeKey: "user-1" }
      );

      expect(result?.check).toMatchObject({ kind: "scoped", keyField: "id", paths: [["board", "owner"]] });
    });
  });

  describe("buildPullQueries", () => {
    it("mirrors validatePush's scoping for a pulled changelog row", () => {
      const [result] = server().buildPullQueries([{ changelogId: "c1", model: "Board", key: "board-1" }], {
        scopeKey: "user-1",
      });

      expect(result?.check).toEqual({
        kind: "scoped",
        keyField: "id",
        key: "board-1",
        rootKeyField: "id",
        scopeKey: "user-1",
        paths: [["owner"]],
      });
    });

    it("resolves the root model directly", () => {
      const [result] = server().buildPullQueries([{ changelogId: "c1", model: "User", key: "user-1" }], {
        scopeKey: "user-1",
      });

      expect(result?.check).toEqual({
        kind: "root",
        keyField: "id",
        key: "user-1",
        scopeKey: "user-1",
        authorized: true,
      });
    });

    it("rejects a log row for a server-only model", () => {
      const [result] = server().buildPullQueries([{ changelogId: "c1", model: "AuditLog", key: "log-1" }], {
        scopeKey: "user-1",
      });

      expect(result?.check).toEqual({ kind: "unknown-model" });
    });
  });
});
