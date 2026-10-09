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
import type { IdbContract } from "../src/exports/orm";

type Row = Record<string, unknown>;
type LooseAccessor = {
  create(data: Row): Promise<Row>;
  where(filter: Row): { update(patch: Row): Promise<Row | null>; all(): { toArray(): Promise<Row[]> } };
  all(): { toArray(): Promise<Row[]> };
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
