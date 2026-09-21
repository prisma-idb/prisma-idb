import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import idbFamilyPack from "@prisma-idb/family-idb/pack";
import idbTargetPack from "@prisma-idb/target-idb/pack";

/**
 * Test contract for the Prisma 8 usage app.
 *
 * Intentionally exercises a broad surface so the Playwright specs in
 * `tests/` can drive every ORM feature without a contract redefinition:
 *
 * - String scalars (nullable and non-nullable) for equality / null-check
 *   / contains / startsWith / endsWith / in / notIn operators
 * - Int scalars (nullable and non-nullable) for gt / lt / gte / lte
 *   numeric comparisons
 * - Boolean scalar for equality
 * - DateTime scalar for date ordering
 * - N:1 + 1:N relation for include() tests
 * - Indexes on both unique (byEmail) and non-unique (byAuthorId, byScore)
 *   columns so index-mutation + accelerated-lookup paths can be exercised
 */
export const contract = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  models: {
    User: {
      store: "users",
      key: "id",
      fields: {
        id: "String",
        name: "String",
        email: "String",
        bio: "String?",
        score: "Int",
        active: "Boolean",
        joinedAt: "DateTime",
      },
      indexes: {
        byEmail: { keyPath: "email", unique: true },
        byScore: { keyPath: "score", unique: false },
      },
      relations: {
        posts: { to: "Post", cardinality: "1:N", on: { local: ["id"], target: ["authorId"] }, onDelete: "cascade" },
      },
    },
    Post: {
      store: "posts",
      key: "id",
      fields: {
        id: "String",
        title: "String",
        content: "String?",
        published: "Boolean",
        views: "Int",
        authorId: "String",
        createdAt: "DateTime",
      },
      indexes: {
        byAuthorId: { keyPath: "authorId", unique: false },
      },
      relations: {
        author: { to: "User", cardinality: "N:1", on: { local: ["authorId"], target: ["id"] } },
        tags: { to: "Tag", cardinality: "1:N", on: { local: ["id"], target: ["postId"] }, onDelete: "cascade" },
      },
    },
    Tag: {
      store: "tags",
      key: "id",
      fields: {
        id: "String",
        name: "String",
        postId: "String",
      },
      indexes: {
        byPostId: { keyPath: "postId", unique: false },
      },
      relations: {
        post: { to: "Post", cardinality: "N:1", on: { local: ["postId"], target: ["id"] } },
      },
    },
    RandomStore: {
      store: "random_store",
      key: "id",
      fields: { id: "String" },
    },
  },
});
