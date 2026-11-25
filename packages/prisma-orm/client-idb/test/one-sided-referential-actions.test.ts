/**
 * Referential actions on a foreign key whose parent declares no inverse
 * relation. The parent's children come from the child's `N:1` relation alone,
 * so every action, every delete and update path, and the store list of an
 * explicit transaction must find them without a parent-side declaration.
 */
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import idbFamilyPack from "@prisma-idb/family-idb/pack";
import idbTargetPack from "@prisma-idb/target-idb/pack";
import type { IdbReferentialAction } from "@prisma-idb/target-idb/pack";
import type { IdbTransactionScope } from "@prisma-idb/driver-idb/runtime";
import type { IdbFilterExpr } from "@prisma-idb/adapter-idb/runtime";
import { createAutoMigratingIdbClient } from "../src/exports/client-auto";
import type { IdbContract } from "../src/exports/orm";
import { buildContractSpaceFixture } from "./_contract-space-fixture";

type Row = Record<string, unknown>;
type Accessor = {
  create(data: Row): Promise<Row>;
  createAll(data: Row[]): { toArray(): Promise<Row[]> };
  delete(key: unknown): Promise<Row>;
  deleteAll(): { toArray(): Promise<Row[]> };
  where(filter: Row | ((model: { id: { in(values: string[]): IdbFilterExpr } }) => IdbFilterExpr)): Accessor;
  update(patch: Row): Promise<Row | null>;
  updateAll(patch: Row): { toArray(): Promise<Row[]> };
  all(): { toArray(): Promise<Row[]> };
};
type Client = {
  orm: Record<string, Accessor>;
  transaction<T>(rootKeys: string[], fn: (tx: Record<string, Accessor>) => Promise<T>): Promise<T>;
  withTransaction<T>(stores: string[], fn: (scope: IdbTransactionScope) => Promise<T>): Promise<T>;
  close(): Promise<void>;
};

let dbCounter = 0;
let client: Client | undefined;

async function open(contract: unknown): Promise<Client> {
  client = (await createAutoMigratingIdbClient({
    contractSpace: buildContractSpaceFixture([contract as IdbContract]),
    dbName: `one-sided-referential-actions-${++dbCounter}`,
  })) as unknown as Client;
  return client;
}

afterEach(async () => {
  await client?.close();
  client = undefined;
});

const rows = (model: string) => client!.orm[model]!.all().toArray();

/** `Post.author` references the unique `User.email`; `User` declares no `posts` relation. */
function oneSided(
  author: { onDelete?: IdbReferentialAction; onUpdate?: IdbReferentialAction },
  authorEmail: "String" | "String?" = "String",
  fieldDefaults?: Record<string, string>
) {
  return defineContract({
    family: idbFamilyPack,
    target: idbTargetPack,
    models: {
      User: {
        store: "users",
        key: "id",
        fields: { id: "String", email: "String" },
        indexes: { byEmail: { keyPath: "email", unique: true } },
      },
      Post: {
        store: "posts",
        key: "id",
        fields: { id: "String", authorEmail: authorEmail },
        ...(fieldDefaults ? { fieldDefaults } : {}),
        relations: {
          author: { to: "User", cardinality: "N:1", on: { local: ["authorEmail"], target: ["email"] }, ...author },
        },
      },
    },
  });
}

async function seed(contract: unknown, users: Row[] = [{ id: "u1", email: "a@e.com" }]) {
  const db = await open(contract);
  await db.orm["users"]!.createAll(users).toArray();
  await db.orm["posts"]!.createAll([
    { id: "p1", authorEmail: "a@e.com" },
    { id: "p2", authorEmail: "a@e.com" },
  ]).toArray();
  return db;
}

it("uses each owning relation's action when reciprocal foreign keys share a join", async () => {
  const db = await open(
    defineContract({
      family: idbFamilyPack,
      target: idbTargetPack,
      models: {
        A: {
          store: "as",
          key: "code",
          fields: { code: "String" },
          relations: {
            b: { to: "B", cardinality: "N:1", on: { local: ["code"], target: ["code"] }, onDelete: "cascade" },
          },
        },
        B: {
          store: "bs",
          key: "code",
          fields: { code: "String" },
          relations: {
            a: { to: "A", cardinality: "N:1", on: { local: ["code"], target: ["code"] } },
          },
        },
      },
    })
  );
  const row = { code: "same" };
  await db.withTransaction(["as", "bs"], async (scope) => {
    await scope.execute({ kind: "put", storeName: "as", record: row } as never);
    await scope.execute({ kind: "put", storeName: "bs", record: row } as never);
  });
  await expect(db.orm["as"]!.delete(row.code)).rejects.toThrow(/child records exist on relation 'B.a'/);
  expect(await rows("as")).toEqual([row]);
  expect(await rows("bs")).toEqual([row]);
});

it("preserves the action on each parent alias of the same join", async () => {
  const db = await open(
    defineContract({
      family: idbFamilyPack,
      target: idbTargetPack,
      models: {
        User: {
          store: "users",
          key: "id",
          fields: { id: "String" },
          relations: {
            posts: { to: "Post", cardinality: "1:N", on: { local: ["id"], target: ["authorId"] } },
            articles: {
              to: "Post",
              cardinality: "1:N",
              on: { local: ["id"], target: ["authorId"] },
              onDelete: "cascade",
            },
          },
        },
        Post: {
          store: "posts",
          key: "id",
          fields: { id: "String", authorId: "String" },
          relations: {
            author: { to: "User", cardinality: "N:1", on: { local: ["authorId"], target: ["id"] } },
          },
        },
      },
    })
  );
  await db.orm["users"]!.create({ id: "u1" });
  await db.orm["posts"]!.create({ id: "p1", authorId: "u1" });
  await expect(db.orm["users"]!.delete("u1")).rejects.toThrow(/child records exist on relation 'posts'/);
  expect(await rows("users")).toEqual([{ id: "u1" }]);
  expect(await rows("posts")).toEqual([{ id: "p1", authorId: "u1" }]);
});

it("preserves the rows when a one-sided action targets an ambiguous legacy Decimal key", async () => {
  const db = await open(
    defineContract({
      family: idbFamilyPack,
      target: idbTargetPack,
      models: {
        User: {
          store: "users",
          key: "id",
          fields: { id: "String", code: "Decimal" },
          indexes: { byCode: { keyPath: "code", unique: true } },
        },
        Post: {
          store: "posts",
          key: "id",
          fields: { id: "String", authorCode: "Decimal" },
          relations: {
            author: {
              to: "User",
              cardinality: "N:1",
              on: { local: ["authorCode"], target: ["code"] },
              onDelete: "cascade",
              onUpdate: "cascade",
            },
          },
        },
      },
    })
  );
  const users = [
    { id: "u1", code: "1" },
    { id: "u2", code: "1.00" },
  ];
  const post = { id: "p1", authorCode: "1.00" };
  await db.withTransaction(["users", "posts"], async (scope) => {
    for (const record of users) await scope.execute({ kind: "put", storeName: "users", record } as never);
    await scope.execute({ kind: "put", storeName: "posts", record: post } as never);
  });
  await expect(db.orm["users"]!.delete("u1")).rejects.toMatchObject({ code: "DECIMAL_IDENTITY_CONFLICT" });
  await expect(db.orm["users"]!.where({ id: "u2" }).update({ code: "2" })).rejects.toMatchObject({
    code: "DECIMAL_IDENTITY_CONFLICT",
  });
  expect(await rows("users")).toEqual(users);
  expect(await rows("posts")).toEqual([post]);
});

it.each([false, true])(
  "uses current parent rows for Decimal actions in a bulk delete (earlier cascade: %s)",
  async (earlierCascade) => {
    const db = await open(
      defineContract({
        family: idbFamilyPack,
        target: idbTargetPack,
        models: {
          Parent: {
            store: "parents",
            key: "id",
            fields: {
              id: "String",
              code: "Decimal",
              status: "String",
              legacyStatus: "String",
              cascadeTag: "String",
              cascadeRef: "String?",
            },
            indexes: {
              codeStatus: { keyPath: ["code", "status"], unique: true },
              legacyStatus: { keyPath: "legacyStatus", unique: true },
              cascadeTag: { keyPath: "cascadeTag", unique: true },
            },
            relations: {
              ancestor: {
                to: "Parent",
                cardinality: "N:1",
                on: { local: ["cascadeRef"], target: ["cascadeTag"] },
                onDelete: "cascade",
              },
            },
          },
          Child: {
            store: "children",
            key: "id",
            fields: { id: "String", code: "Decimal", status: "String" },
            fieldDefaults: { status: "on" },
            relations: {
              parent: {
                to: "Parent",
                cardinality: "N:1",
                on: { local: ["code", "status"], target: ["code", "status"] },
                onDelete: "cascade",
              },
              legacy: {
                to: "Parent",
                cardinality: "N:1",
                on: { local: ["status"], target: ["legacyStatus"] },
                onDelete: "setDefault",
              },
            },
          },
        },
      })
    );
    const parent = (
      id: string,
      code: string,
      status: string,
      legacyStatus: string,
      cascadeRef: string | null = null
    ) => ({
      id,
      code,
      status,
      legacyStatus,
      cascadeTag: id + "-tag",
      cascadeRef,
    });
    const records = [
      earlierCascade ? parent("a", "2", "other-a", "unused-a") : parent("a", "1", "on", "unused-a"),
      parent("b", "3", "other-b", "previous"),
      parent("c", "1.00", "on", "unused-c", earlierCascade ? "a-tag" : null),
      parent("d", "1", "previous", "on"),
      ...(earlierCascade ? [parent("e", "1", "on", "unused-e")] : []),
    ];
    await db.withTransaction(["parents", "children"], async (scope) => {
      for (const record of records) await scope.execute({ kind: "put", storeName: "parents", record } as never);
      await scope.execute({
        kind: "put",
        storeName: "children",
        record: { id: "child", code: "1", status: "previous" },
      } as never);
    });
    await db.orm["parents"]!.where((model) => model.id.in(["a", "b", "c"]))
      .deleteAll()
      .toArray();
    expect(await rows("parents")).toEqual(records.slice(3));
    expect(await rows("children")).toEqual(earlierCascade ? [{ id: "child", code: "1", status: "on" }] : []);
  }
);

describe("one-sided foreign key: actions that keep the child", () => {
  it.each([
    { action: "setNull", contract: oneSided({ onDelete: "setNull", onUpdate: "setNull" }, "String?"), value: null },
    {
      action: "setDefault",
      contract: oneSided({ onDelete: "setDefault", onUpdate: "setDefault" }, "String", { authorEmail: "sys@e.com" }),
      value: "sys@e.com",
    },
  ] as const)(
    "$action rewrites the children on delete and on a referenced-field change",
    async ({ contract, value }) => {
      const users = [
        { id: "u0", email: "sys@e.com" },
        { id: "u1", email: "a@e.com" },
      ];
      let db = await seed(contract, users);
      await db.orm["users"]!.where({ id: "u1" }).update({ email: "b@e.com" });
      expect(await rows("posts")).toEqual([
        { id: "p1", authorEmail: value },
        { id: "p2", authorEmail: value },
      ]);
      await db.close();

      db = await seed(contract, users);
      await db.orm["users"]!.delete("u1");
      expect(await rows("posts")).toEqual([
        { id: "p1", authorEmail: value },
        { id: "p2", authorEmail: value },
      ]);
    }
  );

  it("setDefault refuses a default that points at no parent", async () => {
    const db = await seed(oneSided({ onDelete: "setDefault" }, "String", { authorEmail: "nobody@e.com" }));
    await expect(db.orm["users"]!.delete("u1")).rejects.toThrow(/nobody@e\.com/);
    expect(await rows("users")).toHaveLength(1);
  });
});

describe("one-sided foreign key: restricting actions", () => {
  it.each([
    {},
    { onDelete: "noAction", onUpdate: "noAction" },
    { onDelete: "restrict", onUpdate: "restrict" },
  ] as const)("%o refuses a delete and a referenced-field change while children exist", async (actions) => {
    const db = await seed(oneSided(actions));
    await expect(db.orm["users"]!.delete("u1")).rejects.toThrow(
      /Cannot delete User 'u1': child records exist on relation 'Post\.author'/
    );
    await expect(db.orm["users"]!.where({ id: "u1" }).update({ email: "b@e.com" })).rejects.toThrow(
      /Cannot update User 'u1': changing field\(s\) email .*'Post\.author'/
    );
    expect(await rows("users")).toEqual([{ id: "u1", email: "a@e.com" }]);
    expect(await rows("posts")).toHaveLength(2);
  });

  it("lets a referenced-field change through when no child points at the old value", async () => {
    const db = await seed(oneSided({}), [
      { id: "u1", email: "a@e.com" },
      { id: "u2", email: "c@e.com" },
    ]);
    await db.orm["users"]!.where({ id: "u2" }).update({ email: "d@e.com" });
    expect((await rows("users")).map((row) => row["email"])).toEqual(["a@e.com", "d@e.com"]);
  });
});

describe("one-sided foreign key: bulk writes", () => {
  const users = [
    { id: "u1", email: "a@e.com" },
    { id: "u2", email: "b@e.com" },
  ];

  it("deleteAll() cascades to the children of every deleted row", async () => {
    const db = await seed(oneSided({ onDelete: "cascade" }), users);
    await db.orm["posts"]!.create({ id: "p3", authorEmail: "b@e.com" });
    expect(await db.orm["users"]!.deleteAll().toArray()).toHaveLength(2);
    expect(await rows("posts")).toEqual([]);
  });

  it("deleteAll() restricts and deletes nothing while any row has children", async () => {
    const db = await seed(oneSided({}), users);
    await expect(db.orm["users"]!.deleteAll().toArray()).rejects.toThrow(
      /child records exist on relation 'Post\.author'/
    );
    expect(await rows("users")).toHaveLength(2);
  });

  it("updateAll() cascades each row's referenced-field change", async () => {
    const db = await seed(oneSided({ onUpdate: "cascade" }), users);
    await db.orm["users"]!.where({ id: "u1" }).updateAll({ email: "z@e.com" }).toArray();
    expect((await rows("posts")).map((row) => row["authorEmail"])).toEqual(["z@e.com", "z@e.com"]);
  });
});

describe("one-sided foreign key inside db.transaction()", () => {
  it("declares the child store when only the parent root is opened", async () => {
    const db = await seed(oneSided({ onDelete: "cascade", onUpdate: "cascade" }), [
      { id: "u1", email: "a@e.com" },
      { id: "u2", email: "b@e.com" },
    ]);
    await db.orm["posts"]!.create({ id: "p3", authorEmail: "b@e.com" });
    await db.transaction(["users"], async (tx) => {
      await tx["users"]!.where({ id: "u1" }).update({ email: "z@e.com" });
      await tx["users"]!.delete("u2");
    });
    expect(await rows("posts")).toEqual([
      { id: "p1", authorEmail: "z@e.com" },
      { id: "p2", authorEmail: "z@e.com" },
    ]);
  });
});

describe("one-sided compound foreign key", () => {
  const contract = defineContract({
    family: idbFamilyPack,
    target: idbTargetPack,
    models: {
      User: {
        store: "users",
        key: "id",
        fields: { id: "String", tenant: "String", handle: "String" },
        indexes: { byTenantHandle: { keyPath: ["tenant", "handle"], unique: true } },
      },
      Post: {
        store: "posts",
        key: "id",
        fields: { id: "String", tenant: "String", authorHandle: "String" },
        relations: {
          author: {
            to: "User",
            cardinality: "N:1",
            on: { local: ["tenant", "authorHandle"], target: ["tenant", "handle"] },
            onDelete: "cascade",
            onUpdate: "cascade",
          },
        },
      },
    },
  });

  async function seedCompound() {
    const db = await open(contract);
    await db.orm["users"]!.createAll([
      { id: "u1", tenant: "t1", handle: "ann" },
      { id: "u2", tenant: "t2", handle: "ann" },
    ]).toArray();
    await db.orm["posts"]!.createAll([
      { id: "p1", tenant: "t1", authorHandle: "ann" },
      { id: "p2", tenant: "t2", authorHandle: "ann" },
    ]).toArray();
    return db;
  }

  it("cascades a delete only to the children that match every field", async () => {
    const db = await seedCompound();
    await db.orm["users"]!.delete("u1");
    expect(await rows("posts")).toEqual([{ id: "p2", tenant: "t2", authorHandle: "ann" }]);
  });

  it("cascades a change of one referenced field to the matching children", async () => {
    const db = await seedCompound();
    await db.orm["users"]!.where({ id: "u1" }).update({ handle: "bea" });
    expect(await rows("posts")).toEqual([
      { id: "p1", tenant: "t1", authorHandle: "bea" },
      { id: "p2", tenant: "t2", authorHandle: "ann" },
    ]);
  });
});

describe("one-sided self-relation", () => {
  it("cascades a delete down the whole chain and leaves other rows alone", async () => {
    const contract = defineContract({
      family: idbFamilyPack,
      target: idbTargetPack,
      models: {
        User: {
          store: "users",
          key: "id",
          fields: { id: "String", managerId: "String?" },
          relations: {
            manager: {
              to: "User",
              cardinality: "N:1",
              on: { local: ["managerId"], target: ["id"] },
              onDelete: "cascade",
            },
          },
        },
      },
    });
    const db = await open(contract);
    for (const row of [
      { id: "u1", managerId: null },
      { id: "u2", managerId: "u1" },
      { id: "u3", managerId: "u2" },
      { id: "u4", managerId: null },
    ])
      await db.orm["users"]!.create(row);
    await db.orm["users"]!.delete("u1");
    expect(await rows("users")).toEqual([{ id: "u4", managerId: null }]);
  });
});
