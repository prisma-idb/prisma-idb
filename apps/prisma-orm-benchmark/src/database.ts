import { createIdbClient, type IdbClient } from "@prisma-idb/client-idb/client";
import contractJson from "./contract.json" with { type: "json" };
// Type-only: `defineContract` hashes with `node:crypto`, so the module itself
// can't load in the browser. The runtime value is the emitted JSON
// (`pnpm contract:emit`), built from the same source.
import type { contract as contractSource } from "./contract.server";

type Contract = typeof contractSource;
const contract = contractJson as unknown as Contract;

const DB_NAME = "prisma-orm-benchmark";

export type BenchmarkClient = IdbClient<Contract>;

const pad = (i: number) => String(i).padStart(6, "0");

export const itemId = (i: number) => `item-${pad(i)}`;
export const authorId = (i: number) => `a-${pad(i)}`;
const bookId = (i: number) => `book-${pad(i)}`;

/** Books per author. `datasetSize / BOOKS_PER_AUTHOR` authors are seeded. */
export const BOOKS_PER_AUTHOR = 10;
const CATEGORY_COUNT = 10;
const ORG_COUNT = 5;

/**
 * `n` items: `CATEGORY_COUNT` categories, scores `0..n-1`, two statuses and
 * `ORG_COUNT` orgs. `n / BOOKS_PER_AUTHOR` authors, `n` books spread evenly
 * across them, and one publisher (`p-main`) that owns every book.
 */
function seedRows(n: number): Record<string, Record<string, unknown>[]> {
  const authors = Math.max(1, Math.floor(n / BOOKS_PER_AUTHOR));
  return {
    items: Array.from({ length: n }, (_, i) => ({
      id: itemId(i),
      category: `c${i % CATEGORY_COUNT}`,
      score: i,
      status: i % 2 === 0 ? "open" : "closed",
      orgId: `o${i % ORG_COUNT}`,
      rank: i,
      note: "",
    })),
    authors: Array.from({ length: authors }, (_, i) => ({ id: authorId(i), name: `Author ${i}` })),
    publishers: [{ id: "p-main", name: "Main" }],
    books: Array.from({ length: n }, (_, i) => ({
      id: bookId(i),
      authorId: authorId(i % authors),
      publisherId: "p-main",
      title: `Book ${i}`,
    })),
  };
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/**
 * Deletes the database, recreates every store and index the contract
 * declares, and seeds it. The schema is built directly from the contract,
 * not through migrations: the benchmark measures queries, not upgrades.
 */
export async function createSeededDatabase(datasetSize: number): Promise<void> {
  await request(indexedDB.deleteDatabase(DB_NAME));
  const open = indexedDB.open(DB_NAME, 1);
  open.onupgradeneeded = () => {
    const db = open.result;
    for (const [storeName, def] of Object.entries(contract.storage.stores)) {
      const store = db.createObjectStore(storeName, { keyPath: def.keyPath as string | string[] });
      for (const [indexName, idx] of Object.entries(def.indexes ?? {})) {
        store.createIndex(indexName, idx.keyPath as string | string[], {
          unique: idx.unique ?? false,
          multiEntry: idx.multiEntry ?? false,
        });
      }
    }
  };
  const db = await request(open);
  const rows = seedRows(datasetSize);
  const tx = db.transaction(Object.keys(rows), "readwrite");
  for (const [storeName, records] of Object.entries(rows)) {
    const store = tx.objectStore(storeName);
    for (const record of records) store.put(record);
  }
  await transactionDone(tx);
  db.close();
}

export function openClient(): BenchmarkClient {
  return createIdbClient({ contract, dbName: DB_NAME });
}
