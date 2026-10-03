import { runBenchmarkSuite } from "@prisma-idb/benchmark-kit";
import { describe, expect, it } from "vitest";
import { authorId, BOOKS_PER_AUTHOR, createSeededDatabase, openClient, type BenchmarkClient } from "../src/database";
import { operationDefinitions } from "../src/operations";

const DATASET_SIZE = 100;

/** The row counts the relation-heavy operations read or restore. */
async function countRows(client: BenchmarkClient) {
  return {
    items: (await client.orm.items.all().toArray()).length,
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
