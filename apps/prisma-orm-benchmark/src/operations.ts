import type { BenchmarkOperationDefinition } from "@prisma-idb/benchmark-kit";
import { and, or } from "@prisma-idb/client-idb/orm";
import { authorId, BOOKS_PER_AUTHOR, itemId, type BenchmarkClient } from "./database";

/**
 * Read operations run against the database seeded once before the suite.
 * Mutating operations insert the rows they destroy in `prepare` (untimed),
 * so every store keeps its seeded size from one sample to the next.
 *
 * The shapes mirror the plan-shape gate in `client-idb`: each one is either
 * a query an index can serve, a control that must scan (no usable index),
 * or a regression guard for a shape that is already index-served.
 */
export const BENCHMARK_OPERATION_IDS = [
  "find-all",
  "find-by-primary-key",
  "find-unique",
  "find-eq-indexed",
  "find-eq-unindexed",
  "find-eq-indexed-and-unindexed",
  "find-lt-indexed",
  "find-range-indexed",
  "find-in-indexed",
  "find-or-indexed-eqs",
  "find-or-with-and-branch",
  "find-compound-exact",
  "find-compound-prefix",
  "find-order-by-indexed-take",
  "count-eq-indexed",
  "count-lt-indexed",
  "aggregate-eq-indexed",
  "include-books-by-author",
  "update-all-eq-indexed",
  "delete-all-eq-indexed",
  "delete-cascade-via-indexed-fk",
  "delete-restrict-check",
  "create-with-fk-check",
] as const;

export type BenchmarkOperationId = (typeof BENCHMARK_OPERATION_IDS)[number];

type Definition = BenchmarkOperationDefinition<BenchmarkClient, void, BenchmarkOperationId>;

const noop = async (): Promise<void> => {};

/** Matches 1% of items, and never fewer than one. */
const onePercent = (n: number) => Math.max(1, Math.floor(n / 100));

function read(
  operationId: BenchmarkOperationId,
  label: string,
  run: (client: BenchmarkClient, n: number) => Promise<unknown>
): Definition {
  return {
    operationId,
    label,
    prepare: noop,
    run: async (client, n) => {
      await run(client, n);
    },
  };
}

let uniqueCounter = 0;

export const operationDefinitions: readonly Definition[] = [
  // ── Controls and already-accelerated shapes ──
  read("find-all", "findMany, no filter", (c) => c.orm.items.all().toArray()),
  read("find-by-primary-key", "findMany, eq on primary key", (c) =>
    c.orm.items
      .where({ id: itemId(3) })
      .all()
      .toArray()
  ),
  read("find-unique", "findUnique by primary key", (c) => c.orm.items.findUnique(itemId(3))),
  read("find-eq-indexed", "findMany, eq on indexed field", (c) =>
    c.orm.items.where({ category: "c3" }).all().toArray()
  ),
  read("find-eq-unindexed", "findMany, eq on unindexed field", (c) =>
    c.orm.items.where({ status: "open" }).all().toArray()
  ),
  read("find-eq-indexed-and-unindexed", "findMany, indexed eq AND unindexed eq", (c) =>
    c.orm.items.where({ category: "c3", status: "open" }).all().toArray()
  ),
  read("find-or-indexed-eqs", "findMany, OR of indexed eqs", (c) =>
    c.orm.items
      .where((m) => or(m.category.eq("c1"), m.category.eq("c2")))
      .all()
      .toArray()
  ),

  // ── Shapes an index could serve but that scan today ──
  read("find-lt-indexed", "findMany, lt on indexed field (1%)", (c, n) =>
    c.orm.items
      .where((m) => m.score.lt(onePercent(n)))
      .all()
      .toArray()
  ),
  read("find-range-indexed", "findMany, gte AND lt on indexed field (1%)", (c, n) =>
    c.orm.items
      .where((m) => and(m.score.gte(n / 2), m.score.lt(n / 2 + onePercent(n))))
      .all()
      .toArray()
  ),
  read("find-in-indexed", "findMany, in() on indexed field", (c) =>
    c.orm.items
      .where((m) => m.category.in(["c1", "c2"]))
      .all()
      .toArray()
  ),
  read("find-or-with-and-branch", "findMany, OR with an AND branch", (c) =>
    c.orm.items
      .where((m) => or(and(m.category.eq("c1"), m.status.eq("closed")), m.category.eq("c2")))
      .all()
      .toArray()
  ),
  read("find-compound-exact", "findMany, compound index exact match", (c) =>
    c.orm.items.where({ orgId: "o1", rank: 6 }).all().toArray()
  ),
  read("find-compound-prefix", "findMany, compound index prefix", (c) =>
    c.orm.items.where({ orgId: "o1" }).all().toArray()
  ),
  read("find-order-by-indexed-take", "findMany, orderBy indexed field, take 10", (c) =>
    c.orm.items.orderBy({ score: "asc" }).take(10).all().toArray()
  ),
  read("count-eq-indexed", "count, eq on indexed field", (c) => c.orm.items.where({ category: "c3" }).count()),
  read("count-lt-indexed", "count, lt on indexed field (1%)", (c, n) =>
    c.orm.items.where((m) => m.score.lt(onePercent(n))).count()
  ),
  read("aggregate-eq-indexed", "aggregate count and sum, eq on indexed field", (c) =>
    c.orm.items.where({ category: "c3" }).aggregate((a) => ({ n: a.count(), total: a.sum("score") }))
  ),
  read("include-books-by-author", "include 1:N via indexed foreign key", (c) =>
    // The TS contract builder's relation type doesn't narrow `include()`'s
    // relation-name parameter, so the name needs a cast.
    c.orm.authors
      .where({ id: authorId(1) })
      .include("books" as never)
      .all()
      .toArray()
  ),

  // ── Mutations ──
  {
    operationId: "update-all-eq-indexed",
    label: "updateAll, eq on indexed field",
    prepare: noop,
    run: async (c) => {
      await c.orm.items
        .where({ category: "c3" })
        .updateAll({ note: `n${++uniqueCounter}` })
        .toArray();
    },
  },
  {
    operationId: "delete-all-eq-indexed",
    label: "deleteAll, eq on indexed field (1%)",
    prepare: async (c, n) => {
      const rows = Array.from({ length: onePercent(n) }, (_, i) => ({
        id: `scratch-${i}`,
        category: "c-scratch",
        score: n + i,
        status: "open",
        orgId: "o-scratch",
        rank: n + i,
        note: "",
      }));
      await c.orm.items.createAll(rows).toArray();
    },
    run: async (c) => {
      await c.orm.items.where({ category: "c-scratch" }).deleteAll().toArray();
    },
  },
  {
    operationId: "delete-cascade-via-indexed-fk",
    label: "delete, cascade to children via indexed foreign key",
    prepare: async (c) => {
      await c.orm.authors.create({ id: "a-scratch", name: "Scratch" });
      const books = Array.from({ length: BOOKS_PER_AUTHOR }, (_, i) => ({
        id: `book-scratch-${i}`,
        authorId: "a-scratch",
        publisherId: "p-main",
        title: "Scratch",
      }));
      await c.orm.books.createAll(books).toArray();
    },
    run: async (c) => {
      await c.orm.authors.delete("a-scratch");
    },
  },
  {
    operationId: "delete-restrict-check",
    label: "delete, restrict check with no children",
    prepare: async (c) => {
      await c.orm.publishers.create({ id: "p-scratch", name: "Scratch" });
    },
    run: async (c) => {
      await c.orm.publishers.delete("p-scratch");
    },
  },
  {
    // Last: every sample adds one book, so later operations would see a
    // slightly larger store.
    operationId: "create-with-fk-check",
    label: "create, foreign key validation",
    prepare: noop,
    run: async (c) => {
      await c.orm.books.create({
        id: `book-created-${++uniqueCounter}`,
        authorId: authorId(1),
        publisherId: "p-main",
        title: "Created",
      });
    },
  },
];
