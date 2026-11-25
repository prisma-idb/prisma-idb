import "fake-indexeddb/auto";
import { expect, it, vi } from "vitest";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import family from "@prisma-idb/family-idb/pack";
import target from "@prisma-idb/target-idb/pack";
import { createAutoMigratingIdbClient } from "../src/exports/client-auto";
import type { IdbContract } from "../src/exports/orm";
import { buildContractSpaceFixture } from "./_contract-space-fixture";

it.each(["delete", "update"] as const)(
  "does not require a SetDefault value when %s has no matching children",
  async (kind) => {
    const contract = defineContract({
      family,
      target,
      models: {
        Parent: {
          store: "parents",
          key: "id",
          fields: { id: "String", code: "String" },
          indexes: { code: { keyPath: "code", unique: true } },
        },
        Child: {
          store: "children",
          key: "id",
          fields: { id: "String", parentCode: "String" },
          relations: {
            parent: {
              to: "Parent",
              cardinality: "N:1",
              onDelete: "setDefault",
              onUpdate: "setDefault",
              on: { local: ["parentCode"], target: ["code"] },
            },
          },
        },
      },
    });
    const client = await createAutoMigratingIdbClient({
      contractSpace: buildContractSpaceFixture([contract]),
      dbName: `referential-missing-default-${crypto.randomUUID()}`,
    });
    try {
      await client.orm["parents"]!.create({ id: "p", code: "old" });
      if (kind === "delete") {
        await client.orm["parents"]!.delete("p");
        expect(await client.orm["parents"]!.findUnique("p")).toBeNull();
      } else {
        await client.orm["parents"]!.where({ id: "p" }).update({ code: "new" });
        expect(await client.orm["parents"]!.findUnique("p")).toMatchObject({ code: "new" });
      }
    } finally {
      await client.close();
    }
  }
);

function open(contract: IdbContract) {
  return createAutoMigratingIdbClient({
    contractSpace: buildContractSpaceFixture([contract]),
    dbName: `referential-validation-${crypto.randomUUID()}`,
  });
}

it("checks both SetDefault writes when store names and keys contain separators", async () => {
  const child = (store: string, parentDefault: string) =>
    ({
      store,
      key: "id",
      fields: { id: "String", parentId: "String" },
      fieldDefaults: { parentId: parentDefault },
      relations: {
        parent: {
          to: "Parent",
          cardinality: "N:1",
          on: { local: ["parentId"], target: ["id"] },
          onDelete: "setDefault",
        },
      },
    }) as const;

  const client = await open(
    defineContract({
      family,
      target,
      models: {
        Parent: { store: "parents", key: "id", fields: { id: "String" } },
        Child: child("children", "available"),
        Extra: child("children::extra", "missing"),
      },
    })
  );
  try {
    await client.orm["parents"]!.createAll([{ id: "old" }, { id: "available" }]).toArray();
    await client.orm["children"]!.create({ id: "extra::1", parentId: "old" });
    await client.orm["children::extra"]!.create({ id: "1", parentId: "old" });
    await expect(client.orm["parents"]!.delete("old")).rejects.toThrow(/does not reference a real row/);
    expect(await client.orm["parents"]!.findUnique("old")).toEqual({ id: "old" });
    expect(await client.orm["children"]!.findUnique("extra::1")).toMatchObject({ parentId: "old" });
    expect(await client.orm["children::extra"]!.findUnique("1")).toMatchObject({ parentId: "old" });
  } finally {
    await client.close();
  }
});

it("checks an overlapping foreign key declared only on the referenced model", async () => {
  const client = await open(
    defineContract({
      family,
      target,
      models: {
        User: {
          store: "users",
          key: "id",
          fields: { id: "String", tenant: "String" },
          relations: {
            posts: {
              to: "Post",
              cardinality: "1:N",
              onUpdate: "cascade",
              on: { local: ["tenant", "id"], target: ["tenant", "authorId"] },
            },
          },
        },
        Category: {
          store: "categories",
          key: ["tenant", "id"],
          fields: { tenant: "String", id: "String" },
          relations: {
            posts: {
              to: "Post",
              cardinality: "1:N",
              on: { local: ["tenant", "id"], target: ["tenant", "categoryId"] },
            },
          },
        },
        Post: {
          store: "posts",
          key: "id",
          fields: { id: "String", tenant: "String", authorId: "String", categoryId: "String" },
        },
      },
    })
  );
  try {
    await client.orm["users"]!.create({ id: "u1", tenant: "old" });
    await client.orm["categories"]!.create({ tenant: "old", id: "c1" });
    await client.orm["posts"]!.create({ id: "p1", tenant: "old", authorId: "u1", categoryId: "c1" });

    const user = client.orm["users"]!.where({ id: "u1" });
    await expect(user.update({ tenant: "new" })).rejects.toThrow(/has no Category/);
    expect(await client.orm["posts"]!.findUnique("p1")).toMatchObject({ tenant: "old" });
    expect(await client.orm["users"]!.findUnique("u1")).toMatchObject({ tenant: "old" });

    await client.orm["categories"]!.create({ tenant: "new", id: "c1" });
    await user.update({ tenant: "new" });
    expect(await client.orm["posts"]!.findUnique("p1")).toMatchObject({ tenant: "new" });
  } finally {
    await client.close();
  }
});

it("checks the final foreign key when an action temporarily set it to null", async () => {
  const client = await open(
    defineContract({
      family,
      target,
      models: {
        Category: {
          store: "categories",
          key: "code",
          fields: { code: "String" },
          relations: {
            notes: { to: "Note", cardinality: "1:N", on: { local: ["code"], target: ["parentCode"] } },
          },
        },
        Note: {
          store: "notes",
          key: "id",
          fields: { id: "String", slug: "String", parentCode: "String?" },
          indexes: { bySlug: { keyPath: "slug", unique: true } },
          relations: {
            parent: {
              to: "Note",
              cardinality: "N:1",
              on: { local: ["parentCode"], target: ["slug"] },
              onUpdate: "setNull",
            },
          },
        },
      },
    })
  );
  try {
    await client.orm["categories"]!.createAll([{ code: "old" }, { code: "other" }]).toArray();
    const notes = client.orm["notes"]!;
    await notes.create({ id: "root", slug: "old", parentCode: null });
    await notes.create({ id: "other", slug: "other", parentCode: null });
    const root = notes.where({ id: "root" });
    await root.update({ parentCode: "old" });
    await expect(root.update({ slug: "new", parentCode: "other" })).resolves.toMatchObject({
      slug: "new",
      parentCode: "other",
    });
  } finally {
    await client.close();
  }
});

it("does not recheck an unrelated legacy reference when SetDefault keeps the shared value", async () => {
  const client = await open(
    defineContract({
      family,
      target,
      models: {
        User: { store: "users", key: ["tenant", "id"], fields: { tenant: "String", id: "String" } },
        Category: {
          store: "categories",
          key: ["tenant", "id"],
          fields: { tenant: "String", id: "String" },
          relations: {
            posts: {
              to: "Post",
              cardinality: "1:N",
              on: { local: ["tenant", "id"], target: ["tenant", "categoryId"] },
            },
          },
        },
        Post: {
          store: "posts",
          key: "id",
          fields: { id: "String", tenant: "String", authorId: "String", categoryId: "String" },
          fieldDefaults: { tenant: "t", authorId: "fallback" },
          relations: {
            author: {
              to: "User",
              cardinality: "N:1",
              onDelete: "setDefault",
              on: { local: ["tenant", "authorId"], target: ["tenant", "id"] },
            },
          },
        },
      },
    })
  );
  try {
    await client.orm["users"]!.createAll([
      { tenant: "t", id: "initial" },
      { tenant: "t", id: "fallback" },
    ]).toArray();
    await client.orm["posts"]!.create({ id: "p", tenant: "t", authorId: "initial", categoryId: "missing" });
    await client.orm["users"]!.delete(["t", "initial"]);
    expect(await client.orm["posts"]!.findUnique("p")).toMatchObject({ tenant: "t", authorId: "fallback" });
  } finally {
    await client.close();
  }
});

it.each([false, true])("checks cascades after all nested writes (later invalid write: %s)", async (invalid) => {
  const client = await open(
    defineContract({
      family,
      target,
      models: {
        User: {
          store: "users",
          key: "id",
          fields: { id: "String", tenant: "String", otherTenant: "String" },
          relations: {
            posts: {
              to: "Post",
              cardinality: "1:N",
              onUpdate: "cascade",
              on: { local: ["tenant", "id"], target: ["tenant", "authorId"] },
            },
            categories: { to: "Category", cardinality: "1:N", on: { local: ["id"], target: ["userId"] } },
            otherPosts: {
              to: "Post",
              cardinality: "1:N",
              on: { local: ["otherTenant", "id"], target: ["tenant", "otherOwnerId"] },
            },
          },
        },
        Category: {
          store: "categories",
          key: ["tenant", "id"],
          fields: { tenant: "String", id: "String", userId: "String?" },
          relations: {
            posts: {
              to: "Post",
              cardinality: "1:N",
              on: { local: ["tenant", "id"], target: ["tenant", "categoryId"] },
            },
          },
        },
        Post: {
          store: "posts",
          key: "id",
          fields: { id: "String", tenant: "String", authorId: "String", categoryId: "String", otherOwnerId: "String?" },
        },
      },
    })
  );
  try {
    await client.orm["users"]!.create({ id: "u1", tenant: "t1", otherTenant: "t3" });
    await client.orm["categories"]!.create({ id: "c", tenant: "t1", userId: "u1" });
    await client.orm["posts"]!.create({ id: "p", tenant: "t1", authorId: "u1", categoryId: "c" });
    const user = client.orm["users"]!.where({ id: "u1" });
    if (invalid) {
      await client.orm["categories"]!.create({ id: "c", tenant: "t2", userId: "u1" });
      await expect(
        user.update({
          tenant: "t2",
          otherPosts: (rel: { connect(criteria: Record<string, unknown>): unknown }) => rel.connect({ id: "p" }),
        })
      ).rejects.toThrow(/does not reference a real row/);
    } else {
      await user.update({
        tenant: "t2",
        categories: (rel: { create(data: Record<string, unknown>): unknown }) => rel.create({ tenant: "t2", id: "c" }),
      });
    }
    const tenant = invalid ? "t1" : "t2";
    expect(await client.orm["users"]!.findUnique("u1")).toMatchObject({ tenant });
    expect(await client.orm["posts"]!.findUnique("p")).toMatchObject({ tenant });
  } finally {
    await client.close();
  }
});

it.each([false, true])("checks distinct unindexed tuples in one scan (missing string target: %s)", async (missing) => {
  const client = await open(
    defineContract({
      family,
      target,
      models: {
        User: {
          store: "users",
          key: "id",
          fields: { id: "String", tenant: "String" },
          relations: {
            posts: {
              to: "Post",
              cardinality: "1:N",
              onUpdate: "cascade",
              on: { local: ["tenant", "id"], target: ["tenant", "userId"] },
            },
          },
        },
        Category: {
          store: "categories",
          key: "id",
          fields: { id: "String", tenant: "String", code: "Json" },
          relations: {
            posts: {
              to: "Post",
              cardinality: "1:N",
              on: { local: ["tenant", "code"], target: ["tenant", "categoryCode"] },
            },
          },
        },
        Post: {
          store: "posts",
          key: "id",
          fields: { id: "String", tenant: "String", userId: "String", categoryCode: "Json" },
        },
      },
    })
  );
  try {
    await client.orm["users"]!.create({ id: "u", tenant: "old" });
    const codes = [true, "true", ...Array.from({ length: 24 }, (_, index) => String(index))];
    await client.orm["categories"]!.createAll(
      codes.flatMap((code, index) => [
        { id: `old-${index}`, tenant: "old", code },
        ...(missing && code === "true" ? [] : [{ id: `new-${index}`, tenant: "new", code }]),
      ])
    ).toArray();
    await client.orm["posts"]!.createAll(
      codes.map((categoryCode, index) => ({
        id: String(index).padStart(2, "0"),
        tenant: "old",
        userId: "u",
        categoryCode,
      }))
    ).toArray();

    const cursor = vi.spyOn(IDBObjectStore.prototype, "openCursor");
    try {
      const write = client.orm["users"]!.where({ id: "u" }).update({ tenant: "new" });
      if (missing) await expect(write).rejects.toThrow(/has no Category/);
      else await write;
      expect((cursor.mock.contexts as IDBObjectStore[]).filter((store) => store.name === "categories")).toHaveLength(1);
    } finally {
      cursor.mockRestore();
    }
    expect(await client.orm["posts"]!.findUnique("01")).toMatchObject({ tenant: missing ? "old" : "new" });
  } finally {
    await client.close();
  }
});
