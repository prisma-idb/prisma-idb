/**
 * The first-use marker check on a plain client.
 *
 * A database that was migrated without prisma-idb has no contract marker, so a client opened on it
 * warns once with `CONTRACT.MARKER_MISSING`. `verifyMarker: false` turns the warning off. When a
 * newer version closes the client's connection, the next use checks the marker again.
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

/** Opens `name` at `version`, writing the app marker, as a migration would. */
function migrateTo(name: string, version: number, storageHash: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("users")) db.createObjectStore("users", { keyPath: "id" });
      if (!db.objectStoreNames.contains("_prisma_next_marker")) {
        db.createObjectStore("_prisma_next_marker", { keyPath: "space" });
      }
      request.transaction!.objectStore("_prisma_next_marker").put({ space: "app", storageHash });
    };
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("upgrade blocked"));
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

  it("checks again after a newer version closes the connection, and warns with CONTRACT.MARKER_MISMATCH", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const name = `marker-warning-${++dbCounter}`;
    await migrateTo(name, 1, contract.storage.storageHash);
    const client = createIdbClient({ contract, dbName: name });
    try {
      await client.orm["users"]!.all().toArray();
      expect(warn).not.toHaveBeenCalled();

      // Another tab migrates the database to a newer contract.
      await migrateTo(name, 2, "newer-contract");
      await client.orm["users"]!.all().toArray();
      await client.orm["users"]!.all().toArray();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain("CONTRACT.MARKER_MISMATCH");
      expect(String(warn.mock.calls[0]![0])).toContain("newer-contract");
    } finally {
      await client.close();
    }
  });
});
