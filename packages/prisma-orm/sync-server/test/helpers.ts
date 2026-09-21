import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import idbFamilyPack from "@prisma-idb/family-idb/pack";
import idbTargetPack from "@prisma-idb/target-idb/pack";
import type { DefineContractInput } from "@prisma-idb/family-idb/contract-ts";
import type { SyncServerContract } from "../src/core/ownership-dag";

/**
 * User (root) -> Board -> Todo -> Comment, plus a second Comment path
 * straight to User (multi-path authorization) and a server-only AuditLog
 * island (no relations, `@@idb.exclude`'d — must not be required to reach
 * root).
 */
function kanbanModels(): DefineContractInput["models"] {
  return {
    User: {
      store: "users",
      key: "id",
      fields: { id: "String", name: "String" },
    },
    Board: {
      store: "boards",
      key: "id",
      fields: { id: "String", ownerId: "String" },
      relations: {
        owner: { to: "User", cardinality: "N:1", on: { local: ["ownerId"], target: ["id"] } },
      },
    },
    Todo: {
      store: "todos",
      key: "id",
      fields: { id: "String", boardId: "String" },
      relations: {
        board: { to: "Board", cardinality: "N:1", on: { local: ["boardId"], target: ["id"] } },
      },
    },
    Comment: {
      store: "comments",
      key: "id",
      fields: { id: "String", todoId: "String?", authorId: "String" },
      relations: {
        todo: { to: "Todo", cardinality: "N:1", on: { local: ["todoId"], target: ["id"] } },
        author: { to: "User", cardinality: "N:1", on: { local: ["authorId"], target: ["id"] } },
      },
    },
    AuditLog: {
      store: "auditLogs",
      key: "id",
      fields: { id: "String", action: "String" },
      exclude: true,
    },
  };
}

export function kanbanContract(): SyncServerContract {
  return defineContract({ family: idbFamilyPack, target: idbTargetPack, models: kanbanModels() });
}

export function kanbanClientContract(): SyncServerContract {
  return defineContract(
    { family: idbFamilyPack, target: idbTargetPack, models: kanbanModels() },
    { projection: "client" }
  );
}

/** Same models, but `Tag` is an island (no relations) and NOT excluded. */
export function contractWithUnexcludedIsland(): { contract: SyncServerContract; clientContract: SyncServerContract } {
  const models: DefineContractInput["models"] = {
    ...kanbanModels(),
    Tag: {
      store: "tags",
      key: "id",
      fields: { id: "String", label: "String" },
    },
  };
  const input = { family: idbFamilyPack, target: idbTargetPack, models };
  return {
    contract: defineContract(input),
    clientContract: defineContract(input, { projection: "client" }),
  };
}

/** A -> B -> A, a two-model cycle with no relation to any root candidate. */
export function cyclicContract(): SyncServerContract {
  return defineContract({
    family: idbFamilyPack,
    target: idbTargetPack,
    models: {
      A: {
        store: "as",
        key: "id",
        fields: { id: "String", bId: "String" },
        relations: {
          b: { to: "B", cardinality: "N:1", on: { local: ["bId"], target: ["id"] } },
        },
      },
      B: {
        store: "bs",
        key: "id",
        fields: { id: "String", aId: "String" },
        relations: {
          a: { to: "A", cardinality: "N:1", on: { local: ["aId"], target: ["id"] } },
        },
      },
    },
  });
}
