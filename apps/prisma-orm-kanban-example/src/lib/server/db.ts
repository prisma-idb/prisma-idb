import * as env from "$app/env/private";
import postgres from "@prisma/orm-postgres/runtime";
import { contractFromJson } from "@prisma/orm-postgres/static";
import type { Contract } from "../prisma/schema.postgres.generated.d";
import contractJson from "../prisma/schema.postgres.generated.json" with { type: "json" };

// `src/lib/server/` — SvelteKit refuses to bundle this into client code, so
// the connection string and driver never reach the browser.
const client = postgres<Contract>({ contract: contractFromJson<Contract>(contractJson) });

let connected: Promise<unknown> | null = null;

/** Shares one connected server client and permits retries after connection failures. */
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
