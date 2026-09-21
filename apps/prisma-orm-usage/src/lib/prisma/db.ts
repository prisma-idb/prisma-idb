import { createManagedAutoIdbClient } from "@prisma-idb/client-idb/client-auto";
import type { IdbClient, ManagedIdbClient } from "@prisma-idb/client-idb/client-auto";
import type { Contract } from "./contract";
import { contractSpace } from "./contract-space.generated";

const DEFAULT_DB_NAME = "prisma-idb-usage";

/**
 * Resolve the IDB database name to use for the current page load.
 *
 * Reads `?db=<name>` from the URL when available so each Playwright spec
 * can isolate its own database; falls back to a constant for the
 * interactive UI.
 */
export function resolveDbName(): string {
  if (typeof window === "undefined") return DEFAULT_DB_NAME;
  const param = new URLSearchParams(window.location.search).get("db");
  return param && param.length > 0 ? param : DEFAULT_DB_NAME;
}

// One managed (singleton + race-safe reset) client per db name — Playwright
// specs isolate themselves via `?db=<name>`, and a single page load can
// switch between them via reset() below.
const managedByDbName = new Map<string, ManagedIdbClient<IdbClient<Contract>>>();

function managedDb(dbName: string): ManagedIdbClient<IdbClient<Contract>> {
  let managed = managedByDbName.get(dbName);
  if (!managed) {
    managed = createManagedAutoIdbClient({ contractSpace, dbName });
    managedByDbName.set(dbName, managed);
  }
  return managed;
}

/**
 * Returns the singleton IDB client for the resolved `dbName`, running
 * the auto-migration on first use.
 */
export async function getDb(): Promise<IdbClient<Contract>> {
  return managedDb(resolveDbName()).get();
}

/**
 * Closes the cached client (if any) and deletes the IDB database. Used by
 * the "Reset DB" control in the UI and by Playwright specs that need a
 * guaranteed-clean slate.
 */
export async function resetDb(): Promise<void> {
  await managedDb(resolveDbName()).reset();
}
