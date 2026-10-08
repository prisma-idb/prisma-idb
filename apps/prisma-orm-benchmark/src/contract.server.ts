import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import idbFamilyPack from "@prisma-idb/family-idb/pack";
import idbTargetPack from "@prisma-idb/target-idb/pack";

/**
 * The benchmark schema. Each index exists so one query shape can be served
 * by it: single-field equality and ranges (`byCategory`, `byScore`), a
 * compound index (`byOrgRank`), and indexed foreign keys for relation loads
 * and referential actions (`byAuthor`, `byPublisher`). `status` and `note`
 * are deliberately unindexed. Activity preferences use a unique user/date
 * index to measure ordered history reads with the Date codec.
 */
export const contract = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  models: {
    Item: {
      store: "items",
      key: "id",
      fields: {
        id: "String",
        category: "String",
        score: "Int",
        status: "String",
        orgId: "String",
        rank: "Int",
        note: "String",
      },
      indexes: {
        byCategory: { keyPath: "category", unique: false },
        byScore: { keyPath: "score", unique: false },
        byOrgRank: { keyPath: ["orgId", "rank"], unique: false },
      },
    },
    ActivityPreference: {
      store: "activityPreferences",
      key: "id",
      fields: {
        id: "String",
        userId: "String",
        effectiveFrom: "DateTime",
        activityLevel: "Float",
        steps: "Int",
        weight: "Float",
        note: "String",
      },
      indexes: { byUserEffective: { keyPath: ["userId", "effectiveFrom"], unique: true } },
    },
    Author: {
      store: "authors",
      key: "id",
      fields: { id: "String", name: "String" },
      relations: { books: { to: "Book", cardinality: "1:N", on: { local: ["id"], target: ["authorId"] } } },
    },
    Publisher: {
      store: "publishers",
      key: "id",
      fields: { id: "String", name: "String" },
      relations: { books: { to: "Book", cardinality: "1:N", on: { local: ["id"], target: ["publisherId"] } } },
    },
    Book: {
      store: "books",
      key: "id",
      fields: { id: "String", authorId: "String", publisherId: "String", title: "String" },
      indexes: {
        byAuthor: { keyPath: "authorId", unique: false },
        byPublisher: { keyPath: "publisherId", unique: false },
      },
      relations: {
        author: { to: "Author", cardinality: "N:1", on: { local: ["authorId"], target: ["id"] }, onDelete: "cascade" },
        publisher: { to: "Publisher", cardinality: "N:1", on: { local: ["publisherId"], target: ["id"] } },
      },
    },
  },
});
