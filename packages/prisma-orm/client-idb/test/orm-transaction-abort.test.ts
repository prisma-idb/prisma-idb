/**
 * `db.transaction()` — failures the callback catches.
 *
 * A failed operation aborts the whole transaction even when the callback
 * catches the error. These tests cover failures that never reach the
 * database, such as enum validation. They also cover the stores a multi-hop
 * `onUpdate` cascade needs.
 */
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { buildSymbolTable } from "@prisma/orm-framework/psl-parser";
import { parse } from "@prisma/orm-framework/psl-parser/syntax";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import { interpretPslDocumentToIdbContract } from "@prisma-idb/family-idb/contract-psl";
import idbFamilyPack from "@prisma-idb/family-idb/pack";
import idbTargetPack from "@prisma-idb/target-idb/pack";
import { createIdbClient } from "../src/exports/client";
import { IdbRecordValidationError, type IdbContract } from "../src/exports/orm";

type Row = Record<string, unknown>;
type LooseAccessor = {
  create(data: Row): Promise<Row>;
  where(filter: Row): { update(patch: Row): Promise<Row | null>; all(): { toArray(): Promise<Row[]> } };
  all(): { toArray(): Promise<Row[]> };
  createAll(data: Row[]): PromiseLike<Row[]>;
  createCount(data: Row[]): Promise<number>;
  update(patch: Row): Promise<Row | null>;
  updateAll(patch: Row): PromiseLike<Row[]>;
  updateCount(patch: Row): Promise<number>;
  upsert(args: { where: Row; create: Row; update: Row }): Promise<Row>;
  include(relation: string, refine: (related: { count(): unknown }) => unknown): unknown;
};
type LooseClient = {
  orm: Record<string, LooseAccessor>;
  transaction<T>(rootKeys: string[], fn: (tx: Record<string, LooseAccessor>) => Promise<T>): Promise<T>;
  close(): Promise<void>;
};

let dbCounter = 0;
const open: LooseClient[] = [];

async function openClient(contract: IdbContract, stores: string[]): Promise<LooseClient> {
  const dbName = `orm-transaction-abort-test-${++dbCounter}`;
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.open(dbName, 1);
    req.onupgradeneeded = () => {
      for (const store of stores) req.result.createObjectStore(store, { keyPath: "id" });
    };
    req.onsuccess = () => {
      req.result.close();
      resolve();
    };
    req.onerror = () => reject(req.error);
  });
  const db = createIdbClient({ contract, dbName }) as unknown as LooseClient;
  open.push(db);
  return db;
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((db) => db.close()));
});

const ids = async (accessor: LooseAccessor) => (await accessor.all().toArray()).map((row) => row["id"]);

describe("db.transaction() — validation failures the callback catches", () => {
  const { document, sources } = parse(
    "enum Role {\n USER\n ADMIN\n}\nmodel Member {\n id String @id\n role Role\n}",
    "s.prisma"
  );
  const { symbolTable } = buildSymbolTable({ documents: [document], sources, pslBlockDescriptors: {} });
  const result = interpretPslDocumentToIdbContract(symbolTable, "s.prisma");
  if (!result.ok) throw new Error(JSON.stringify(result.failure.diagnostics));
  const enumContract = result.value as IdbContract;

  it.each(["create", "createAll", "createCount", "update", "updateAll", "updateCount", "upsert"] as const)(
    "aborts when the callback catches scalar validation in %s",
    async (method) => {
      const db = await openClient(enumContract, ["member"]);
      await db.orm["member"]!.create({ id: "existing", role: "USER" });
      let caught: unknown;
      await expect(
        db.transaction(["member"], async (tx) => {
          await tx["member"]!.create({ id: "earlier", role: "USER" });
          try {
            const members = tx["member"]!;
            switch (method) {
              case "create":
                await members.create({ id: 3, role: "USER" });
                break;
              case "createAll":
                await members.createAll([
                  { id: "valid", role: "USER" },
                  { id: 3, role: "USER" },
                ]);
                break;
              case "createCount":
                await members.createCount([{ id: 3, role: "USER" }]);
                break;
              case "update":
                await members.update({ role: undefined });
                break;
              case "updateAll":
                await members.updateAll({ role: undefined });
                break;
              case "updateCount":
                await members.updateCount({ role: undefined });
                break;
              case "upsert":
                await members.upsert({ where: { id: "existing" }, create: { id: 3, role: "USER" }, update: {} });
                break;
            }
          } catch (error) {
            caught = error;
          }
        })
      ).rejects.toThrow();
      expect(caught).toBeInstanceOf(IdbRecordValidationError);
      expect(await db.orm["member"]!.all().toArray()).toEqual([{ id: "existing", role: "USER" }]);
    }
  );

  it("aborts when a create is rejected by enum validation and the callback catches it", async () => {
    const db = await openClient(enumContract, ["member"]);

    await expect(
      db.transaction(["member"], async (tx) => {
        await tx["member"]!.create({ id: "good", role: "USER" });
        await tx["member"]!.create({ id: "bad", role: "OWNER" }).catch(() => undefined);
      })
    ).rejects.toThrow();

    expect(await ids(db.orm["member"]!)).toEqual([]);
  });

  it("aborts when an update is rejected by enum validation and the callback catches it", async () => {
    const db = await openClient(enumContract, ["member"]);
    await db.orm["member"]!.create({ id: "m1", role: "USER" });

    await expect(
      db.transaction(["member"], async (tx) => {
        await tx["member"]!.create({ id: "m2", role: "USER" });
        await tx["member"]!.where({ id: "m1" })
          .update({ role: "OWNER" })
          .catch(() => undefined);
      })
    ).rejects.toThrow();

    expect(await ids(db.orm["member"]!)).toEqual(["m1"]);
  });

  it("aborts when a createAll that is awaited directly is rejected and the callback catches it", async () => {
    const db = await openClient(enumContract, ["member"]);

    await expect(
      db.transaction(["member"], async (tx) => {
        await tx["member"]!.create({ id: "good", role: "USER" });
        try {
          await tx["member"]!.createAll([{ id: "bad", role: "OWNER" }]);
        } catch {
          // The callback swallows the error; the transaction must still abort.
        }
      })
    ).rejects.toThrow();

    expect(await ids(db.orm["member"]!)).toEqual([]);
  });
});

describe("db.transaction() — errors thrown synchronously by an accessor", () => {
  const contract = defineContract({
    family: idbFamilyPack,
    target: idbTargetPack,
    models: {
      User: { store: "users", key: "id", fields: { id: "String" } },
      Post: {
        store: "posts",
        key: "id",
        fields: { id: "String", authorId: "String" },
        relations: { author: { to: "User", cardinality: "N:1", on: { local: ["authorId"], target: ["id"] } } },
      },
    },
  });

  it("aborts when a to-one include() count() throws and the callback catches it", async () => {
    const db = await openClient(contract, ["users", "posts"]);

    await expect(
      db.transaction(["users", "posts"], async (tx) => {
        await tx["users"]!.create({ id: "u1" });
        try {
          tx["posts"]!.include("author", (author) => author.count());
        } catch {
          // The callback swallows the error; the transaction must still abort.
        }
      })
    ).rejects.toThrow();

    expect(await ids(db.orm["users"]!)).toEqual([]);
  });
});

describe("db.transaction() — multi-hop onUpdate cascade", () => {
  const contract = defineContract({
    family: idbFamilyPack,
    target: idbTargetPack,
    models: {
      User: {
        store: "users",
        key: "id",
        fields: { id: "String", slug: "String" },
        relations: {
          posts: {
            to: "Post",
            cardinality: "1:N",
            on: { local: ["slug"], target: ["authorSlug"] },
            onUpdate: "cascade",
            onDelete: "restrict",
          },
        },
      },
      Post: {
        store: "posts",
        key: "id",
        fields: { id: "String", authorSlug: "String" },
        relations: {
          comments: {
            to: "Comment",
            cardinality: "1:N",
            on: { local: ["authorSlug"], target: ["postAuthorSlug"] },
            onUpdate: "cascade",
            onDelete: "restrict",
          },
        },
      },
      Comment: {
        store: "comments",
        key: "id",
        fields: { id: "String", postAuthorSlug: "String" },
      },
    },
  });

  it("opens every store the cascade reaches, not only the direct children", async () => {
    const db = await openClient(contract, ["users", "posts", "comments"]);
    await db.orm["users"]!.create({ id: "u1", slug: "alice" });
    await db.orm["posts"]!.create({ id: "p1", authorSlug: "alice" });
    await db.orm["comments"]!.create({ id: "c1", postAuthorSlug: "alice" });

    await db.transaction(["users"], async (tx) => {
      await tx["users"]!.where({ id: "u1" }).update({ slug: "alicia" });
    });

    expect((await db.orm["posts"]!.all().toArray())[0]!["authorSlug"]).toBe("alicia");
    expect((await db.orm["comments"]!.all().toArray())[0]!["postAuthorSlug"]).toBe("alicia");
  });
});
