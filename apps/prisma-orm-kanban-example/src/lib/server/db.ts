import { env } from "$env/dynamic/private";
import postgres from "@prisma/orm-postgres/runtime";
import type { Contract } from "../prisma/schema.postgres.generated.d";
import contractJson from "../prisma/schema.postgres.generated.json" with { type: "json" };

// `src/lib/server/` — SvelteKit refuses to bundle this into client code, so
// the connection string and driver never reach the browser.
const client = postgres<Contract>({ contractJson });

let connected: Promise<unknown> | null = null;

export async function getPostgres() {
  if (!connected) {
    if (!env.DATABASE_URL) {
      throw new Error("DATABASE_URL is not set — copy .env.example to .env and run `pnpm db:up && pnpm db:init`.");
    }
    // Clear on rejection (e.g. Postgres not up yet) so the next call retries
    // instead of re-awaiting the same rejected promise forever.
    connected = client.connect({ url: env.DATABASE_URL }).catch((err: unknown) => {
      connected = null;
      throw err;
    });
  }
  await connected;
  return client;
}
