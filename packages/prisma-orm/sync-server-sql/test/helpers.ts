import "dotenv/config";
import pg from "pg";
import postgres from "@prisma/orm-postgres/runtime";
import type { SyncServerContract } from "@prisma-idb/sync-server";
import type { Contract } from "./fixtures/schema.generated.d";
import contractJson from "./fixtures/schema.generated.json" with { type: "json" };
import { ormRootFor } from "../src/core/orm-root";

/**
 * The real contract emitted from test/fixtures/schema.prisma (User (root)
 * <- Board (ownerId) <- Todo (boardId), plus the SQL-flavored `Changelog`
 * `sqlContractWithSync` appends) — this package's own suite runs
 * against a real Postgres client built from this, not a hand-rolled fake.
 */
export const testContract = contractJson as unknown as SyncServerContract;

function requiredDatabaseUrl(): string {
  const url = process.env["DATABASE_URL"];
  if (!url) {
    throw new Error("DATABASE_URL is not set — copy .env.example to .env first.");
  }
  return url;
}

const client = postgres<Contract>({ contractJson });
// A second, independent connection to the same database, used only for
// `resetTestDb`'s TRUNCATE — deliberately not routed through the ORM
// client, whose `.delete()`/`.deleteAll()` refuse to run unfiltered.
const resetPool = new pg.Pool({ connectionString: requiredDatabaseUrl() });

let connected: Promise<unknown> | null = null;

/** The real Prisma 8 Postgres client — connects once, reused across the suite. */
export async function testDb() {
  if (!connected) {
    connected = client.connect({ url: requiredDatabaseUrl() }).catch((err: unknown) => {
      connected = null;
      throw err;
    });
  }
  await connected;
  return client;
}

export async function closeTestDb(): Promise<void> {
  await client.close();
  await resetPool.end();
}

/** Empties every fixture table between tests — a real TRUNCATE, not a mock reset. */
export async function resetTestDb(): Promise<void> {
  await resetPool.query('TRUNCATE TABLE "changelog", "todo", "board", "user" RESTART IDENTITY CASCADE');
}

/**
 * Inserts fixture rows through the real ORM, in the order given — callers
 * are responsible for parent-before-child ordering (`User` before `Board`
 * before `Todo`), the same FK-dependency order Postgres itself requires.
 */
export async function seed(
  db: Awaited<ReturnType<typeof testDb>>,
  rows: Partial<Record<"User" | "Board" | "Todo" | "Changelog", Record<string, unknown>[]>>
): Promise<void> {
  for (const [model, modelRows] of Object.entries(rows)) {
    for (const row of modelRows ?? []) {
      await ormRootFor(db, model).select("id").create(row);
    }
  }
}
