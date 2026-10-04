import { describe, expect, it, vi } from "vitest";
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
    it("rejects malformed records and keys before resolving ownership paths", () => {
      const contract = kanbanContract();
      const getKeyField = vi.fn((_contract: SyncServerContract, _model: string) => "id");
      const syncServer = createSyncServer({
        contract,
        clientContract: kanbanClientContract(),
        rootModel: "User",
        getKeyField,
      });
      const [badRecord, badKey] = syncServer.validatePush(
        [
          { id: "e1", model: "Todo", operation: "create", payload: { id: "t1", boardId: 42 }, wireKey: "t1" },
          { id: "e2", model: "Todo", operation: "delete", payload: { id: 42 }, wireKey: 42 },
        ],
        { scopeKey: "user-1" }
      );
      expect(badRecord?.check).toMatchObject({ kind: "validation-failure", error: "RECORD_VALIDATION_FAILURE" });
      expect(badKey?.check).toMatchObject({ kind: "validation-failure", error: "KEYPATH_VALIDATION_FAILURE" });
      // A scoped ownership check would additionally resolve the root's key field.
      expect(getKeyField.mock.calls.map(([, model]) => model)).toEqual(["Todo", "Todo"]);
    });

    it.each([
      ["pg/int8@1", 42n, "42"],
      ["pg/unboundedint@1", 42n, "42"],
      ["pg/bytea@1", new Uint8Array([1, 2]), "AQI="],
      ["pg/timestamptz-date@1", new Date("2026-01-02T03:04:05.000Z"), "2026-01-02T03:04:05.000Z"],
    ])("keeps root and scoped keys in wire form for %s", (codecId, nativeKey, wireKey) => {
      const contract = kanbanContract();
      for (const model of ["User", "Board"]) {
        contract.domain.namespaces[Object.keys(contract.domain.namespaces)[0]!]!.models[model]!.fields["id"] = {
          nullable: false,
          type: { kind: "scalar", codecId: codecId as string },
        };
      }
      const syncServer = createSyncServer({ contract, clientContract: kanbanClientContract(), rootModel: "User" });
      const [root, scoped, invalid] = syncServer.validatePush(
        [
          { id: "root", model: "User", operation: "delete", payload: { id: nativeKey }, wireKey },
          {
            id: "scoped",
            model: "Board",
            operation: "delete",
            payload: { id: nativeKey },
            wireKey,
          },
          { id: "invalid", model: "User", operation: "delete", payload: { id: false }, wireKey },
        ],
        { scopeKey: wireKey as string }
      );
      expect(root?.check).toMatchObject({ kind: "root", key: wireKey, authorized: true });
      expect(scoped?.check).toMatchObject({ kind: "scoped", key: wireKey });
      expect(invalid?.check).toMatchObject({ kind: "validation-failure", error: "KEYPATH_VALIDATION_FAILURE" });
    });

    it("requires the wire key, so an event can't skip the ownership key form", () => {
      const event = { id: "e1", model: "User", operation: "delete", payload: { id: "user-1" } } as const;

      // @ts-expect-error `wireKey` is required: without it the ownership check has no key to compare.
      const [result] = server().validatePush([event], { scopeKey: "user-1" });

      // At runtime the missing key is exactly the silent mismatch the type prevents.
      expect(result?.check).toMatchObject({ kind: "root", authorized: false });
    });

    it("validates only client-visible fields while resolving ownership from the full model", () => {
      const contract = kanbanContract();
      const clientContract = kanbanClientContract();
      const clientBoard = Object.values(clientContract.domain.namespaces)[0]!.models["Board"]!;
      delete clientBoard.fields["ownerId"];
      delete clientBoard.relations["owner"];
      clientBoard.fields["label"] = { nullable: true, type: { kind: "scalar", codecId: "idb/string@1" } };
      const getKeyField = vi.fn((_contract: SyncServerContract, _model: string) => "id");
      const syncServer = createSyncServer({ contract, clientContract, rootModel: "User", getKeyField });
      const [valid, missingKey, hiddenField, badVisibleCreate, badVisibleUpdate] = syncServer.validatePush(
        [
          { id: "valid", model: "Board", operation: "create", payload: { id: "b1" }, wireKey: "b1" },
          { id: "key", model: "Board", operation: "create", payload: {}, wireKey: undefined },
          { id: "hidden", model: "Board", operation: "update", payload: { id: "b1", ownerId: "u1" }, wireKey: "b1" },
          { id: "create", model: "Board", operation: "create", payload: { id: "b1", label: 42 }, wireKey: "b1" },
          { id: "update", model: "Board", operation: "update", payload: { id: "b1", label: 42 }, wireKey: "b1" },
        ],
        { scopeKey: "u1" }
      );
      expect(valid?.check).toEqual({
        kind: "scoped",
        keyField: "id",
        key: "b1",
        rootKeyField: "id",
        scopeKey: "u1",
        paths: [["owner"]],
      });
      expect(missingKey?.check).toMatchObject({ kind: "validation-failure", error: "KEYPATH_VALIDATION_FAILURE" });
      for (const result of [hiddenField, badVisibleCreate, badVisibleUpdate]) {
        expect(result?.check).toMatchObject({ kind: "validation-failure", error: "RECORD_VALIDATION_FAILURE" });
      }
      expect(getKeyField.mock.calls.every(([checkedContract]) => checkedContract === contract)).toBe(true);
    });

    it("checks updates as patches and deletes as key-only events", () => {
      const results = server().validatePush(
        [
          { id: "missing", model: "User", operation: "create", payload: { id: "user-1" }, wireKey: "user-1" },
          { id: "update", model: "User", operation: "update", payload: { id: "user-1", name: 42 }, wireKey: "user-1" },
          {
            id: "extra",
            model: "User",
            operation: "update",
            payload: { id: "user-1", extra: true },
            wireKey: "user-1",
          },
          { id: "delete", model: "User", operation: "delete", payload: { id: "user-1" }, wireKey: "user-1" },
        ],
        { scopeKey: "user-1" }
      );
      for (const result of results.slice(0, 3))
        expect(result.check).toMatchObject({ kind: "validation-failure", error: "RECORD_VALIDATION_FAILURE" });
      expect(results[3]?.check).toMatchObject({ kind: "root", authorized: true });
    });

    it("resolves the root model directly, no paths needed", () => {
      const [result] = server().validatePush(
        [{ id: "e1", model: "User", operation: "update", payload: { id: "user-1", name: "Ada" }, wireKey: "user-1" }],
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
        [
          {
            id: "e1",
            model: "User",
            operation: "update",
            payload: { id: "someone-else", name: "Ada" },
            wireKey: "someone-else",
          },
        ],
        { scopeKey: "user-1" }
      );

      expect(result?.check).toMatchObject({ kind: "root", authorized: false });
    });

    it("resolves a non-root model to every authorization path", () => {
      const [result] = server().validatePush(
        [
          {
            id: "e1",
            model: "Todo",
            operation: "create",
            payload: { id: "todo-1", boardId: "board-1" },
            wireKey: "todo-1",
          },
        ],
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
        [
          {
            id: "e1",
            model: "Comment",
            operation: "create",
            payload: { id: "c1", todoId: null, authorId: "user-1" },
            wireKey: "c1",
          },
        ],
        { scopeKey: "user-1" }
      );

      expect(result?.check).toMatchObject({
        kind: "scoped",
        paths: [["author"], ["todo", "board", "owner"]],
      });
    });

    it("rejects an event for a model the client contract never exposes", () => {
      const [result] = server().validatePush(
        [{ id: "e1", model: "AuditLog", operation: "create", payload: { id: "log-1" }, wireKey: "log-1" }],
        { scopeKey: "user-1" }
      );

      expect(result?.check).toEqual({ kind: "unknown-model" });
    });

    it("rejects an event for a model that doesn't exist at all", () => {
      const [result] = server().validatePush(
        [{ id: "e1", model: "Ghost", operation: "create", payload: {}, wireKey: undefined }],
        {
          scopeKey: "user-1",
        }
      );

      expect(result?.check).toEqual({ kind: "unknown-model" });
    });

    it("processes every event independently, preserving order", () => {
      const results = server().validatePush(
        [
          { id: "e1", model: "User", operation: "update", payload: { id: "user-1" }, wireKey: "user-1" },
          {
            id: "e2",
            model: "Board",
            operation: "create",
            payload: { id: "board-1", ownerId: "user-1" },
            wireKey: "board-1",
          },
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
        syncServer.validatePush(
          [{ id: "e1", model: "User", operation: "update", payload: { id: "user-1" }, wireKey: "user-1" }],
          {
            scopeKey: "user-1",
          }
        )
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
        [
          {
            id: "e1",
            model: "Todo",
            operation: "create",
            payload: { id: "todo-1", boardId: "board-1" },
            wireKey: "todo-1",
          },
        ],
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
