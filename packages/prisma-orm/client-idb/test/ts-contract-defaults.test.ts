/**
 * A contract authored with `defineContract` fills the same create-time and
 * update-time defaults as the equivalent PSL contract. The PSL and TypeScript
 * contracts below describe one model, so both must also hash alike.
 */
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { buildSymbolTable } from "@prisma/orm-framework/psl-parser";
import { parse } from "@prisma/orm-framework/psl-parser/syntax";
import { interpretPslDocumentToIdbContract } from "@prisma-idb/family-idb/contract-psl";
import { autoincrement, defineContract, gen, now } from "@prisma-idb/family-idb/contract-ts";
import idbFamilyPack from "@prisma-idb/family-idb/pack";
import idbTargetPack from "@prisma-idb/target-idb/pack";
import { createIdbClient } from "../src/exports/client";
import type { IdbContract } from "../src/exports/orm";

const PSL = `
  model Event {
    id        Int      @id @default(autoincrement())
    uid       String   @onCreate(uuid())
    ordered   String   @onCreate(uuid(7))
    slug      String   @onCreate(cuid(2))
    createdAt DateTime @default(now())
    touchedAt DateTime @onCreate(now()) @onUpdate(now())
    name      String
  }
`;

const tsContract = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  models: {
    Event: {
      store: "event",
      key: "id",
      fields: {
        id: "Int",
        uid: "String",
        ordered: "String",
        slug: "String",
        createdAt: "DateTime",
        touchedAt: "DateTime",
        name: "String",
      },
      defaults: {
        id: autoincrement(),
        uid: { onCreate: gen.uuid() },
        ordered: { onCreate: gen.uuid(7) },
        slug: { onCreate: gen.cuid(2) },
        createdAt: now(),
        touchedAt: { onCreate: gen.now(), onUpdate: gen.now() },
      },
    },
  },
}) as IdbContract;

/** The contract of a PSL schema, as `contract.json` hands it to the client. */
function pslContractOf(schema: string): IdbContract {
  const { document, sources } = parse(schema, "schema.prisma");
  const { symbolTable } = buildSymbolTable({ documents: [document], sources, defaultNamespaceId: "__unbound__" });
  const result = interpretPslDocumentToIdbContract(symbolTable, "schema.prisma");
  if (!result.ok) throw new Error(JSON.stringify(result.failure.diagnostics));
  return JSON.parse(JSON.stringify(result.value)) as IdbContract;
}

const pslContract = pslContractOf(PSL);

let dbCounter = 0;
let client: ReturnType<typeof createIdbClient> | undefined;

/** Open a fresh database with the contract's stores, then a client on it. */
async function openClient(contract: IdbContract): Promise<ReturnType<typeof createIdbClient>> {
  const dbName = `ts-contract-defaults-test-${++dbCounter}`;
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.open(dbName, 1);
    req.onupgradeneeded = () => {
      for (const [name, store] of Object.entries(contract.storage.stores)) {
        const objectStore = req.result.createObjectStore(name, {
          keyPath: store.keyPath as string,
          autoIncrement: store.autoIncrement ?? false,
        });
        for (const [indexName, index] of Object.entries(store.indexes ?? {})) {
          objectStore.createIndex(indexName, index.keyPath as string | string[], {
            unique: index.unique ?? false,
            multiEntry: index.multiEntry ?? false,
          });
        }
      }
    };
    req.onsuccess = () => {
      req.result.close();
      resolve();
    };
    req.onerror = () => reject(req.error);
  });
  return createIdbClient({ contract, dbName });
}

afterEach(async () => {
  await client?.close();
  client = undefined;
});

describe("PSL tagged date defaults", () => {
  it("creates and reads native dates after contract JSON serialization, preserving explicit values", async () => {
    const { document, sources } = parse(
      "model Event {\n id Int @id @default(autoincrement())\n startsAt DateTime? @default(date`2024-02-29T00:00:00Z`)\n}",
      "schema.prisma"
    );
    const { symbolTable } = buildSymbolTable({ documents: [document], sources, defaultNamespaceId: "__unbound__" });
    const result = interpretPslDocumentToIdbContract(symbolTable, "schema.prisma");
    if (!result.ok) throw new Error(JSON.stringify(result.failure.diagnostics));
    client = await openClient(JSON.parse(JSON.stringify(result.value)) as IdbContract);
    const events = client.orm["event"]!;
    const first = (await events.create({})) as Record<string, unknown>;
    expect(first["startsAt"]).toEqual(new Date("2024-02-29T00:00:00.000Z"));

    // Mutating a returned default must not affect the next record's default.
    (first["startsAt"] as Date).setUTCFullYear(2030);
    await events.create({});
    const explicit = new Date("2025-01-01T12:00:00.000Z");
    await events.create({ startsAt: explicit });
    await events.create({ startsAt: null });
    expect(await events.orderBy({ id: "asc" }).all().toArray()).toEqual([
      { id: 1, startsAt: new Date("2024-02-29T00:00:00.000Z") },
      { id: 2, startsAt: new Date("2024-02-29T00:00:00.000Z") },
      { id: 3, startsAt: explicit },
      { id: 4, startsAt: null },
    ]);
  });
});

describe("PSL @onCreate and @onUpdate generators", () => {
  const contract = pslContractOf(`
    model Event {
      id        Int      @id @default(autoincrement())
      ulid      String   @onCreate(ulid())
      nanoid    String   @onCreate(nanoid(10))
      ksuid     String   @onCreate(ksuid())
      touchedAt DateTime @onCreate(now()) @onUpdate(now())
      code      String?  @onCreate(ulid())
      name      String
    }
  `);

  it("fills ulid(), nanoid(size) and ksuid() with a fresh identifier on each create()", async () => {
    client = await openClient(contract);
    const events = client.orm["event"]!;

    const first = (await events.create({ name: "first" })) as Record<string, unknown>;
    const second = (await events.create({ name: "second" })) as Record<string, unknown>;

    expect(first["ulid"]).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(first["nanoid"]).toMatch(/^[A-Za-z0-9_-]{10}$/);
    expect(first["ksuid"]).toMatch(/^[0-9A-Za-z]{27}$/);
    for (const field of ["ulid", "nanoid", "ksuid"]) expect(first[field]).not.toBe(second[field]);
  });

  it("fills an optional field when it is omitted, and keeps an explicit null", async () => {
    client = await openClient(contract);
    const events = client.orm["event"]!;

    const filled = (await events.create({ name: "filled" })) as Record<string, unknown>;
    const empty = (await events.create({ name: "empty", code: null })) as Record<string, unknown>;

    expect(filled["code"]).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(empty["code"]).toBeNull();
  });

  it("advances @onUpdate(now()) on update()", async () => {
    client = await openClient(contract);
    const events = client.orm["event"]!;
    const old = new Date("2020-01-01T00:00:00.000Z");
    await events.create({ name: "first", touchedAt: old });

    const updated = (await events.where({ id: 1 }).update({ name: "renamed" })) as Record<string, unknown>;

    expect((updated["touchedAt"] as Date).getTime()).toBeGreaterThan(old.getTime());
  });
});

describe("@onUpdate(...) generators across several rows", () => {
  const contract = pslContractOf(`
    model Author {
      id    String @id
      posts Post[]
    }
    model Post {
      id        String   @id
      authorId  String?
      author    Author?  @relation(fields: [authorId], references: [id])
      token     String   @onCreate(uuid()) @onUpdate(uuid(7))
      touchedAt DateTime @onCreate(now()) @onUpdate(now())
      name      String
    }
  `);

  async function seed() {
    client = await openClient(contract);
    await client.orm["author"]!.create({ id: "a1" });
    for (const id of ["p1", "p2", "p3"]) await client.orm["post"]!.create({ id, authorId: "a1", name: id });
    return client.orm["post"]!;
  }

  it("gives each row its own uuid() on updateAll(), and every row the same now()", async () => {
    const posts = await seed();

    const rows = (await posts.where({ authorId: "a1" }).updateAll({ name: "renamed" }).toArray()) as Record<
      string,
      unknown
    >[];

    expect(new Set(rows.map((row) => row["token"])).size).toBe(3);
    expect(new Set(rows.map((row) => (row["touchedAt"] as Date).getTime())).size).toBe(1);
  });

  it("keeps an explicit value over the generator on every row", async () => {
    const posts = await seed();

    const rows = (await posts.where({ authorId: "a1" }).updateAll({ token: "fixed" }).toArray()) as Record<
      string,
      unknown
    >[];

    expect(rows.map((row) => row["token"])).toEqual(["fixed", "fixed", "fixed"]);
  });

  it("gives each child its own uuid() when a nested disconnect() writes several rows", async () => {
    const posts = await seed();
    const before = new Set((await posts.all().toArray()).map((row) => (row as Record<string, unknown>)["token"]));

    await client!.orm["author"]!.where({ id: "a1" }).update({
      posts: (rel: { disconnect(): unknown }) => rel.disconnect(),
    } as never);

    const rows = (await posts.all().toArray()) as Record<string, unknown>[];
    expect(rows.map((row) => row["authorId"])).toEqual([null, null, null]);
    const tokens = rows.map((row) => row["token"]);
    expect(new Set(tokens).size).toBe(3);
    for (const token of tokens) expect(before.has(token)).toBe(false);
  });
});

describe("@onUpdate(...) generators on fields other rows depend on", () => {
  it("checks the foreign key of every row updateAll() regenerates", async () => {
    client = await openClient(
      pslContractOf(`
        model Owner {
          id   String @id
          pets Pet[]
        }
        model Pet {
          id      String @id
          ownerId String @onUpdate(uuid())
          owner   Owner  @relation(fields: [ownerId], references: [id])
          name    String
        }
      `)
    );
    await client.orm["owner"]!.create({ id: "o1" });
    for (const id of ["p1", "p2"]) await client.orm["pet"]!.create({ id, ownerId: "o1", name: id });

    await expect(client.orm["pet"]!.where({ ownerId: "o1" }).updateAll({ name: "renamed" }).toArray()).rejects.toThrow(
      /FK violation on relation 'owner'/
    );
    expect(
      (await client.orm["pet"]!.all().toArray()).map((row) => (row as Record<string, unknown>)["ownerId"])
    ).toEqual(["o1", "o1"]);
  });

  /** Authors own posts; each post has a generated slug that attachments reference. */
  function slugContract(onUpdate: "Restrict" | "Cascade") {
    return pslContractOf(`
      model Author {
        id    String @id
        posts Post[]
      }
      model Post {
        id          String       @id
        authorId    String?
        author      Author?      @relation(fields: [authorId], references: [id])
        slug        String       @unique @onCreate(uuid()) @onUpdate(uuid())
        attachments Attachment[]
      }
      model Attachment {
        id       String @id
        postSlug String
        post     Post   @relation(fields: [postSlug], references: [slug], onUpdate: ${onUpdate})
      }
    `);
  }

  async function seedSlugs(onUpdate: "Restrict" | "Cascade") {
    client = await openClient(slugContract(onUpdate));
    await client.orm["author"]!.create({ id: "a1" });
    const post = (await client.orm["post"]!.create({ id: "p1", authorId: "a1" })) as Record<string, unknown>;
    await client.orm["attachment"]!.create({ id: "f1", postSlug: post["slug"] });
    return post["slug"];
  }

  const disconnectPosts = () =>
    client!.orm["author"]!.where({ id: "a1" }).update({
      posts: (rel: { disconnect(): unknown }) => rel.disconnect(),
    } as never);

  it("applies onUpdate: Restrict when a nested disconnect() regenerates a referenced field", async () => {
    const slug = await seedSlugs("Restrict");

    await expect(disconnectPosts()).rejects.toThrow(/would orphan child records on relation 'attachments'/);
    expect(await client!.orm["post"]!.findUnique("p1")).toMatchObject({ authorId: "a1", slug });
  });

  it("applies onUpdate: Restrict when a nested disconnect() moves a referenced @onUpdate(now()) field", async () => {
    client = await openClient(
      pslContractOf(`
        model Author {
          id    String @id
          posts Post[]
        }
        model Post {
          id          String       @id
          authorId    String?
          author      Author?      @relation(fields: [authorId], references: [id])
          touchedAt   DateTime     @unique @onCreate(now()) @onUpdate(now())
          attachments Attachment[]
        }
        model Attachment {
          id            String   @id
          postTouchedAt DateTime
          post          Post     @relation(fields: [postTouchedAt], references: [touchedAt], onUpdate: Restrict)
        }
      `)
    );
    await client.orm["author"]!.create({ id: "a1" });
    const old = new Date("2020-01-01T00:00:00.000Z");
    await client.orm["post"]!.create({ id: "p1", authorId: "a1", touchedAt: old });
    await client.orm["attachment"]!.create({ id: "f1", postTouchedAt: old });

    await expect(disconnectPosts()).rejects.toThrow(/would orphan child records on relation 'attachments'/);
    expect(await client!.orm["post"]!.findUnique("p1")).toMatchObject({ authorId: "a1", touchedAt: old });
  });

  it("applies onUpdate: Cascade when a nested disconnect() regenerates a referenced field", async () => {
    const slug = await seedSlugs("Cascade");

    await disconnectPosts();

    const post = (await client!.orm["post"]!.findUnique("p1")) as Record<string, unknown>;
    expect(post["slug"]).not.toBe(slug);
    expect(await client!.orm["attachment"]!.findUnique("f1")).toMatchObject({ postSlug: post["slug"] });
  });
});

describe("TypeScript-authored execution defaults", () => {
  it("hashes the same as the equivalent PSL contract", () => {
    expect(tsContract.storage.storageHash).toBe(pslContract.storage.storageHash);
    expect(tsContract.execution?.executionHash).toBe(pslContract.execution?.executionHash);
    expect(tsContract.execution?.executionHash).toBeDefined();
  });

  describe.each([
    ["TypeScript", tsContract],
    ["PSL", pslContract],
  ])("%s contract", (_surface, contract) => {
    it("fills now(), autoincrement() and the uuid(), uuid(7), cuid(2) and now() generators on create()", async () => {
      client = await openClient(contract);
      const events = client.orm["event"]!;
      const before = Date.now();

      const first = (await events.create({ name: "first" })) as Record<string, unknown>;
      const second = (await events.create({ name: "second" })) as Record<string, unknown>;

      expect([first["id"], second["id"]]).toEqual([1, 2]);
      expect(first["uid"]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(first["ordered"]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(first["slug"]).toEqual(expect.any(String));
      expect(first["uid"]).not.toBe(second["uid"]);
      expect(first["slug"]).not.toBe(second["slug"]);
      for (const field of ["createdAt", "touchedAt"]) {
        expect(first[field]).toBeInstanceOf(Date);
        expect((first[field] as Date).getTime()).toBeGreaterThanOrEqual(before);
      }
    });

    it("advances onUpdate: gen.now() on update() but leaves now() alone", async () => {
      client = await openClient(contract);
      const events = client.orm["event"]!;
      const old = new Date("2020-01-01T00:00:00.000Z");
      await events.create({ name: "first", createdAt: old, touchedAt: old });

      const updated = (await events.where({ id: 1 }).update({ name: "renamed" })) as Record<string, unknown>;

      expect(updated["createdAt"]).toEqual(old);
      expect((updated["touchedAt"] as Date).getTime()).toBeGreaterThan(old.getTime());
    });

    it("lets a caller-provided value win over a default", async () => {
      client = await openClient(contract);
      const events = client.orm["event"]!;

      const row = (await events.create({ name: "x", uid: "custom-uid" })) as Record<string, unknown>;

      expect(row["uid"]).toBe("custom-uid");
    });
  });
});
