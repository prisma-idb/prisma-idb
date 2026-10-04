import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { AsyncIterableResult } from "@prisma/orm-framework/components/runtime";
import { buildSymbolTable } from "@prisma/orm-framework/psl-parser";
import { parse } from "@prisma/orm-framework/psl-parser/syntax";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import { interpretPslDocumentToIdbContract } from "@prisma-idb/family-idb/contract-psl";
import idbFamilyPack from "@prisma-idb/family-idb/pack";
import idbTargetPack from "@prisma-idb/target-idb/pack";
import { createIDBRuntimeDriver } from "@prisma-idb/driver-idb/runtime";
import type { IdbQueryPlan } from "@prisma-idb/adapter-idb/runtime";
import { idbOrm } from "../src/exports/orm";

function pslContract() {
  const { document, sources } = parse(
    `
    model User {
      id String @id
      posts Post[] @relation("PostAuthor")
      editedPosts Post[] @relation("PostEditor")
      @@map("users")
    }
    model Post {
      id String @id
      authorId String
      editorId String
      author User @relation("PostAuthor", fields: [authorId], references: [id])
      editor User @relation("PostEditor", fields: [editorId], references: [id])
      @@map("posts")
    }
  `,
    "test.prisma"
  );
  const { symbolTable } = buildSymbolTable({ documents: [document], sources, pslBlockDescriptors: {} });
  const result = interpretPslDocumentToIdbContract(symbolTable, "test.prisma");
  if (!result.ok) throw new Error(JSON.stringify(result.failure));
  return result.value;
}

function tsContract() {
  // TS-DSL names each relation field and specifies its join directly.
  return defineContract({
    family: idbFamilyPack,
    target: idbTargetPack,
    models: {
      User: {
        store: "users",
        key: "id",
        fields: { id: "String" },
        relations: {
          posts: { to: "Post", cardinality: "1:N", on: { local: ["id"], target: ["authorId"] } },
          editedPosts: { to: "Post", cardinality: "1:N", on: { local: ["id"], target: ["editorId"] } },
        },
      },
      Post: {
        store: "posts",
        key: "id",
        fields: { id: "String", authorId: "String", editorId: "String" },
        relations: {
          author: { to: "User", cardinality: "N:1", on: { local: ["authorId"], target: ["id"] } },
          editor: { to: "User", cardinality: "N:1", on: { local: ["editorId"], target: ["id"] } },
        },
      },
    },
  });
}

type Row = Record<string, unknown>;
type Accessor = {
  create(data: Row): Promise<unknown>;
  include(relation: string): { all(): { toArray(): Promise<Row[]> } };
};

let db: IDBDatabase | undefined;
let dbCounter = 0;
afterEach(() => db?.close());

describe.each([
  { name: "PSL", contract: pslContract },
  { name: "TS-DSL", contract: tsContract },
])("same-target relations from $name", ({ contract }) => {
  it("includes authored and edited posts through their own foreign keys", async () => {
    const name = `same-target-relations-${++dbCounter}`;
    db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("users", { keyPath: "id" });
        const posts = request.result.createObjectStore("posts", { keyPath: "id" });
        posts.createIndex("authorId", "authorId");
        posts.createIndex("editorId", "editorId");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const driver = createIDBRuntimeDriver(name).create();
    const executor = {
      query<R>(plan: IdbQueryPlan<R>) {
        return new AsyncIterableResult(
          (async function* () {
            for await (const row of driver.execute(plan.idbPlan)) yield row as R;
          })()
        );
      },
      transaction(storeNames: string[], mode?: IDBTransactionMode) {
        return driver.transaction(storeNames, mode);
      },
    };
    const orm = idbOrm({ contract: contract(), executor }) as unknown as Record<string, Accessor>;
    await orm["users"]!.create({ id: "alice" });
    await orm["users"]!.create({ id: "bob" });
    await orm["posts"]!.create({ id: "p1", authorId: "alice", editorId: "bob" });
    await orm["posts"]!.create({ id: "p2", authorId: "bob", editorId: "alice" });
    await orm["posts"]!.create({ id: "p3", authorId: "alice", editorId: "alice" });

    for (const [relation, expected] of [
      ["posts", { alice: ["p1", "p3"], bob: ["p2"] }],
      ["editedPosts", { alice: ["p2", "p3"], bob: ["p1"] }],
    ] as const) {
      const users = await orm["users"]!.include(relation).all().toArray();
      expect(
        Object.fromEntries(
          users.map((user) => [user["id"], (user[relation] as Row[]).map((post) => post["id"]).sort()])
        )
      ).toEqual(expected);
    }
    for (const [relation, expected] of [
      ["author", { p1: "alice", p2: "bob", p3: "alice" }],
      ["editor", { p1: "bob", p2: "alice", p3: "alice" }],
    ] as const) {
      const posts = await orm["posts"]!.include(relation).all().toArray();
      expect(Object.fromEntries(posts.map((post) => [post["id"], (post[relation] as Row)["id"]]))).toEqual(expected);
    }
  });
});
