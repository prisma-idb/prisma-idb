import { and } from "@prisma-idb/client-idb/orm";
import { runBenchmarkSuite } from "@prisma-idb/benchmark-kit";
import { describe, expect, it } from "vitest";
import { authorId, BOOKS_PER_AUTHOR, createSeededDatabase, openClient, type BenchmarkClient } from "../src/database";
import { operationDefinitions } from "../src/operations";

const DATASET_SIZE = 100;

/** The row counts the relation-heavy operations read or restore. */
async function countRows(client: BenchmarkClient) {
  return {
    items: (await client.orm.items.all().toArray()).length,
    activityPreferences: await client.orm.activityPreferences.count(),
    authors: (await client.orm.authors.all().toArray()).length,
    books: (await client.orm.books.all().toArray()).length,
    booksOfFirstAuthor: await client.orm.books.where({ authorId: authorId(1) }).count(),
    publishers: (await client.orm.publishers.all().toArray()).length,
  };
}

describe("operationDefinitions", () => {
  it("leave the seeded row counts unchanged for the operation that runs next, in every round", async () => {
    await createSeededDatabase(DATASET_SIZE);
    const client = openClient();
    try {
      const seeded = await countRows(client);
      expect(seeded.booksOfFirstAuthor).toBe(BOOKS_PER_AUTHOR);

      // Looks at the data right before each operation's own `prepare`, which
      // is where an earlier operation's leftovers would show.
      const countsBeforeEachSample: Awaited<ReturnType<typeof countRows>>[] = [];
      const definitions = operationDefinitions.map((definition) => ({
        ...definition,
        prepare: async (c: BenchmarkClient, n: number) => {
          countsBeforeEachSample.push(await countRows(c));
          return definition.prepare(c, n);
        },
      }));

      const config = { datasetSize: DATASET_SIZE, warmupRuns: 1, measuredRuns: 2 };
      await runBenchmarkSuite({ client, definitions, config });

      expect(countsBeforeEachSample).toHaveLength(operationDefinitions.length * 3);
      for (const counts of countsBeforeEachSample) expect(counts).toEqual(seeded);
      expect(await countRows(client)).toEqual(seeded);
    } finally {
      await client.close();
    }
  });
});

it("seeds realistic Date history with a strict cutoff and future rows", async () => {
  await createSeededDatabase(100);
  const client = openClient();
  try {
    expect(await client.orm.activityPreferences.count()).toBe(100);
    const cutoff = new Date(Date.UTC(2010, 0, 17));
    const first = await client.orm.activityPreferences
      .where((m) => and(m.userId.eq("u1"), m.effectiveFrom.lt(cutoff)))
      .orderBy({ effectiveFrom: "desc" })
      .first();
    expect(first).toMatchObject({ userId: "u1", effectiveFrom: new Date(Date.UTC(2010, 0, 16)) });
    expect(first?.note).toMatch(/^.{200,}$/);
    expect(await client.orm.activityPreferences.where((m) => m.effectiveFrom.gte(cutoff)).count()).toBe(20);
    expect(operationDefinitions.map((definition) => definition.operationId)).toContain(
      "find-date-compound-suffix-first"
    );
  } finally {
    await client.close();
  }
});
