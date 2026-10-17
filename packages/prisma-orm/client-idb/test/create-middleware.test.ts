/**
 * `create()` runs the full middleware lifecycle.
 *
 * The runtime calls `activityEnded` when the result is fully read or the caller
 * stops reading. Reading to the end reports `succeeded`; returning early from
 * the read loop reports `stopped` even though the row was stored.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import idbFamilyPack from "@prisma-idb/family-idb/pack";
import idbTargetPack from "@prisma-idb/target-idb/pack";
import type { IdbMiddleware } from "@prisma-idb/runtime-idb/runtime";
import { createIdbClient } from "../src/exports/client";
import type { IdbStoreAccessor } from "../src/exports/orm";

const contract = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  models: {
    User: { store: "users", key: "id", fields: { id: "String", email: "String" } },
  },
});

let dbCounter = 0;
let client: ReturnType<typeof createIdbClient> | undefined;

/** Creates the object stores a client expects, then opens it with `middleware`. */
async function openClient(middleware: readonly IdbMiddleware[]): Promise<ReturnType<typeof createIdbClient>> {
  const dbName = `create-middleware-test-${++dbCounter}`;
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.open(dbName, 1);
    req.onupgradeneeded = () => {
      for (const [name, store] of Object.entries(contract.storage.stores)) {
        req.result.createObjectStore(name, { keyPath: store.keyPath as string });
      }
    };
    req.onsuccess = () => {
      req.result.close();
      resolve();
    };
    req.onerror = () => reject(req.error);
  });
  return createIdbClient({ contract, dbName, middleware });
}

afterEach(async () => client?.close());

describe("create() and middleware", () => {
  let events: string[];

  beforeEach(async () => {
    events = [];
    client = await openClient([
      {
        name: "recorder",
        familyId: "idb",
        async beforeEncode(plan) {
          events.push(`beforeEncode:${plan.kind}`);
        },
        async activityEnded(_activity, result) {
          if (result.kind === "statement") events.push(`activityEnded:${result.outcome}`);
        },
      } as IdbMiddleware,
    ]);
  });

  it("ends the activity once the stored row has been returned", async () => {
    const users = client!.orm["users"] as unknown as IdbStoreAccessor<never, never> & {
      create(data: Record<string, unknown>): Promise<Record<string, unknown>>;
    };

    const created = await users.create({ id: "u1", email: "a@example.com" });

    expect(created).toMatchObject({ id: "u1", email: "a@example.com" });
    expect(events).toEqual(["beforeEncode:add", "activityEnded:succeeded"]);
  });
});
