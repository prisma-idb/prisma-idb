/**
 * The first-use marker check on a plain client.
 *
 * A database that was migrated without prisma-idb has no contract marker, so a client opened on it
 * warns once with `CONTRACT.MARKER_MISSING`. `verifyMarker: false` turns the warning off.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import "fake-indexeddb/auto";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import idbFamilyPack from "@prisma-idb/family-idb/pack";
import idbTargetPack from "@prisma-idb/target-idb/pack";
import { createIdbClient } from "../src/exports/client";

const contract = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  models: { User: { store: "users", key: "id", fields: { id: "String", name: "String" } } },
});

let dbCounter = 0;

function createHandMigratedDb(): Promise<string> {
  const name = `marker-warning-${++dbCounter}`;
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("users", { keyPath: "id" });
    request.onsuccess = () => {
      request.result.close();
      resolve(name);
    };
    request.onerror = () => reject(request.error);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("first-use marker check on a plain client", () => {
  it("warns once with CONTRACT.MARKER_MISSING when the database has no marker", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = createIdbClient({ contract, dbName: await createHandMigratedDb() });
    try {
      await client.orm["users"]!.all().toArray();
      await client.orm["users"]!.all().toArray();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain("CONTRACT.MARKER_MISSING");
    } finally {
      await client.close();
    }
  });

  it("stays quiet when verifyMarker is false", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = createIdbClient({ contract, dbName: await createHandMigratedDb(), verifyMarker: false });
    try {
      await client.orm["users"]!.all().toArray();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });
});
