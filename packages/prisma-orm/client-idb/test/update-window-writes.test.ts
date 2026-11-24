/**
 * `update()` after `orderBy()` or `skip()` reads the rows first and writes the
 * picked one. That branch must still run every check the plain update runs:
 * foreign keys, `onUpdate` actions, list operations and per-row defaults.
 * `take(0)` selects no row but still rejects invalid data, as Prisma does.
 */
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { buildSymbolTable } from "@prisma/orm-framework/psl-parser";
import { parse } from "@prisma/orm-framework/psl-parser/syntax";
import { interpretPslDocumentToIdbContract } from "@prisma-idb/family-idb/contract-psl";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import idbFamilyPack from "@prisma-idb/family-idb/pack";
import idbTargetPack from "@prisma-idb/target-idb/pack";
import { createAutoMigratingIdbClient } from "../src/exports/client-auto";
import { IdbRecordValidationError, type IdbContract } from "../src/exports/orm";
import { buildContractSpaceFixture } from "./_contract-space-fixture";

function pslContractOf(schema: string): IdbContract {
  const { document, sources } = parse(schema, "schema.prisma");
  const { symbolTable } = buildSymbolTable({ documents: [document], sources, defaultNamespaceId: "__unbound__" });
  const result = interpretPslDocumentToIdbContract(symbolTable, "schema.prisma");
  if (!result.ok) throw new Error(JSON.stringify(result.failure.diagnostics));
  return JSON.parse(JSON.stringify(result.value)) as IdbContract;
}

let dbCounter = 0;
let client: Awaited<ReturnType<typeof open>> | undefined;

async function open(contract: IdbContract) {
  return createAutoMigratingIdbClient({
    contractSpace: buildContractSpaceFixture([contract]),
    dbName: `update-window-writes-${++dbCounter}`,
  });
}

afterEach(async () => {
  await client?.close();
  client = undefined;
});

type Rows = Record<string, unknown>[];
const rowsOf = async (model: string) => (await client!.orm[model]!.all().toArray()) as Rows;

describe("windowed update() with foreign keys", () => {
  const contract = pslContractOf(`
    model Owner {
      id    String @id
      posts Post[]
    }
    model Post {
      id      String @id
      rank    Int
      ownerId String
      owner   Owner  @relation(fields: [ownerId], references: [id])
    }
  `);

  async function seed() {
    client = await open(contract);
    await client.orm["owner"]!.createAll([{ id: "o1" }, { id: "o2" }]).toArray();
    await client.orm["post"]!.createAll([
      { id: "p1", rank: 1, ownerId: "o1" },
      { id: "p2", rank: 2, ownerId: "o1" },
    ]).toArray();
    return client.orm["post"]!;
  }

  it("rejects a foreign key that points nowhere and writes nothing", async () => {
    const posts = await seed();
    await expect(posts.orderBy({ rank: "desc" }).update({ ownerId: "missing" })).rejects.toThrow(
      /FK violation on relation 'owner'/
    );
    expect(await rowsOf("post")).toEqual([
      { id: "p1", rank: 1, ownerId: "o1" },
      { id: "p2", rank: 2, ownerId: "o1" },
    ]);
  });

  it("moves only the row the order and offset pick when the parent exists", async () => {
    const posts = await seed();
    expect(await posts.orderBy({ rank: "desc" }).update({ ownerId: "o2" })).toMatchObject({ id: "p2", ownerId: "o2" });
    expect(await posts.orderBy({ rank: "desc" }).skip(1).update({ ownerId: "o2" })).toMatchObject({ id: "p1" });
    expect((await rowsOf("post")).map((row) => row["ownerId"])).toEqual(["o2", "o2"]);
  });
});

describe("windowed update() with a partially set compound foreign key", () => {
  const contract = defineContract({
    family: idbFamilyPack,
    target: idbTargetPack,
    models: {
      User: { store: "users", key: ["tenantId", "id"], fields: { tenantId: "String", id: "String" } },
      Post: {
        store: "posts",
        key: "id",
        fields: { id: "String", rank: "Int", tenantId: "String", authorId: "String" },
        relations: {
          author: {
            to: "User",
            cardinality: "N:1",
            on: { local: ["tenantId", "authorId"], target: ["tenantId", "id"] },
          },
        },
      },
    },
  }) as IdbContract;

  it("checks the picked row's own author against the new tenant", async () => {
    client = await open(contract);
    await client.orm["users"]!.createAll([
      { tenantId: "old", id: "alice" },
      { tenantId: "old", id: "bob" },
      { tenantId: "new", id: "bob" },
    ]).toArray();
    await client.orm["posts"]!.createAll([
      { id: "p1", rank: 1, tenantId: "old", authorId: "bob" },
      { id: "p2", rank: 2, tenantId: "old", authorId: "alice" },
    ]).toArray();
    const posts = client.orm["posts"]!;

    // The highest-ranked post is alice's, and "new" has no alice.
    await expect(posts.orderBy({ rank: "desc" }).update({ tenantId: "new" })).rejects.toThrow(/FK violation/);
    expect((await rowsOf("posts")).map((row) => row["tenantId"])).toEqual(["old", "old"]);
    expect(await posts.orderBy({ rank: "asc" }).update({ tenantId: "new" })).toMatchObject({ id: "p1" });
  });
});

describe("windowed update() with onUpdate actions", () => {
  function slugContract(onUpdate: "Cascade" | "Restrict") {
    return pslContractOf(`
      model Owner {
        id       String  @id
        rank     Int
        slug     String  @unique
        children Child[]
      }
      model Child {
        id        String @id
        ownerSlug String
        owner     Owner  @relation(fields: [ownerSlug], references: [slug], onUpdate: ${onUpdate})
      }
    `);
  }

  async function seed(onUpdate: "Cascade" | "Restrict") {
    client = await open(slugContract(onUpdate));
    await client.orm["owner"]!.createAll([
      { id: "o1", rank: 1, slug: "a" },
      { id: "o2", rank: 2, slug: "b" },
    ]).toArray();
    await client.orm["child"]!.createAll([
      { id: "c1", ownerSlug: "a" },
      { id: "c2", ownerSlug: "b" },
    ]).toArray();
    return client.orm["owner"]!;
  }

  it("cascades a changed referenced value to the children of the picked row only", async () => {
    const owners = await seed("Cascade");
    expect(await owners.orderBy({ rank: "desc" }).update({ slug: "b2" })).toMatchObject({ id: "o2", slug: "b2" });
    expect(await rowsOf("child")).toEqual([
      { id: "c1", ownerSlug: "a" },
      { id: "c2", ownerSlug: "b2" },
    ]);
    expect(await owners.orderBy({ rank: "desc" }).skip(1).update({ slug: "a2" })).toMatchObject({ id: "o1" });
    expect((await rowsOf("child")).map((row) => row["ownerSlug"])).toEqual(["a2", "b2"]);
  });

  it("restricts a changed referenced value of the picked row and writes nothing", async () => {
    const owners = await seed("Restrict");
    await expect(owners.orderBy({ rank: "desc" }).update({ slug: "b2" })).rejects.toThrow(
      /would orphan child records on relation 'children'/
    );
    expect((await rowsOf("owner")).map((row) => row["slug"])).toEqual(["a", "b"]);
    expect((await rowsOf("child")).map((row) => row["ownerSlug"])).toEqual(["a", "b"]);
  });
});

describe("windowed update() with per-row defaults", () => {
  it("regenerates the picked row's @onUpdate value and leaves the others alone", async () => {
    client = await open(
      pslContractOf(`
        model Item {
          id    String @id
          rank  Int
          token String @onCreate(uuid()) @onUpdate(uuid())
          name  String
        }
      `)
    );
    await client.orm["item"]!.createAll([
      { id: "i1", rank: 1, name: "one" },
      { id: "i2", rank: 2, name: "two" },
    ]).toArray();
    const before = await rowsOf("item");

    const updated = await client.orm["item"]!.orderBy({ rank: "desc" }).update({ name: "renamed" });

    const after = await rowsOf("item");
    expect(updated).toMatchObject({ id: "i2", name: "renamed" });
    expect(updated!["token"]).not.toBe(before[1]!["token"]);
    expect(after[0]).toEqual(before[0]);
  });

  it("checks the foreign key a per-row default regenerates", async () => {
    client = await open(
      pslContractOf(`
        model Owner {
          id   String @id
          pets Pet[]
        }
        model Pet {
          id      String @id
          rank    Int
          ownerId String @onUpdate(uuid())
          owner   Owner  @relation(fields: [ownerId], references: [id])
          name    String
        }
      `)
    );
    await client.orm["owner"]!.create({ id: "o1" });
    await client.orm["pet"]!.createAll([
      { id: "p1", rank: 1, ownerId: "o1", name: "one" },
      { id: "p2", rank: 2, ownerId: "o1", name: "two" },
    ]).toArray();

    await expect(client.orm["pet"]!.orderBy({ rank: "desc" }).update({ name: "renamed" })).rejects.toThrow(
      /FK violation on relation 'owner'/
    );
    expect((await rowsOf("pet")).map((row) => row["name"])).toEqual(["one", "two"]);
  });
});

describe("windowed update() with list operations", () => {
  const contract = defineContract({
    family: idbFamilyPack,
    target: idbTargetPack,
    models: {
      Sample: {
        store: "samples",
        key: "id",
        fields: { id: "String", rank: "Int", values: "String[]" },
      },
    },
  }) as IdbContract;

  it("applies push to the picked row's own list", async () => {
    client = await open(contract);
    const samples = client.orm["samples"]!;
    await samples
      .createAll([
        { id: "s1", rank: 1, values: ["a"] },
        { id: "s2", rank: 2, values: ["b"] },
      ])
      .toArray();

    const updated = await samples.orderBy({ rank: "desc" }).update((u) => [u["values"]!.push("c")]);

    expect(updated).toMatchObject({ id: "s2", values: ["b", "c"] });
    expect((await rowsOf("samples")).map((row) => row["values"])).toEqual([["a"], ["b", "c"]]);
  });
});

describe("update() after take(0)", () => {
  const contract = pslContractOf(`
    model User {
      id   String @id
      name String
    }
  `);

  it("returns null for valid data and rejects invalid data as a plain update would", async () => {
    client = await open(contract);
    const users = client.orm["user"]!;
    await users.create({ id: "u1", name: "Alice" });

    expect(await users.take(0).update({ name: "Bob" })).toBeNull();
    await expect(users.take(0).update({ name: 3 })).rejects.toThrow(IdbRecordValidationError);
    await expect(users.update({ name: 3 })).rejects.toThrow(IdbRecordValidationError);
    expect(await rowsOf("user")).toEqual([{ id: "u1", name: "Alice" }]);
  });
});
