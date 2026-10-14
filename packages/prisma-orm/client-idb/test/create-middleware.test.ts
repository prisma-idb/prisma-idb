/**
 * `create()` runs the full middleware lifecycle.
 *
 * The runtime fires `afterQuery` only after the result has been read to its
 * end. A `create()` that returned from inside the read loop skipped the hook,
 * so telemetry and audit middleware saw a write start and never finish.
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
        async beforeExecute() {},
        async beforeQuery(plan) {
          events.push(`beforeQuery:${plan.kind}`);
        },
        async afterQuery(plan) {
          events.push(`afterQuery:${plan.kind}`);
        },
      } as IdbMiddleware,
    ]);
  });

  it("fires afterQuery once the stored row has been returned", async () => {
    const users = client!.orm["users"] as unknown as IdbStoreAccessor<never, never> & {
      create(data: Record<string, unknown>): Promise<Record<string, unknown>>;
    };

    const created = await users.create({ id: "u1", email: "a@example.com" });

    expect(created).toMatchObject({ id: "u1", email: "a@example.com" });
    expect(events).toEqual(["beforeQuery:add", "afterQuery:add"]);
  });
});
