import { describe, expect, it } from "vitest";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import idbFamilyPack from "@prisma-idb/family-idb/pack";
import idbTargetPack from "@prisma-idb/target-idb/pack";
import type { IdbContract } from "@prisma-idb/client-idb/orm";
import { createSyncIdbClient } from "../src/exports/client";
import { applyPull } from "../src/core/apply-pull";
import { versionMetaKey } from "../src/core/version-meta";
import { OUTBOX_STORE, VERSION_META_STORE, openTestDb, scanAll, testDbName, changelogId, asAccessors } from "./helpers";

/** A Float key can be ±Infinity, which `JSON.stringify` writes as null. */
async function setup(compound: boolean) {
  const keyPath = compound ? ["x", "group"] : "x";
  const contract = defineContract({
    family: idbFamilyPack,
    target: idbTargetPack,
    models: { Point: { store: "points", key: keyPath, fields: { x: "Float", group: "String", note: "String" } } },
  }) as unknown as IdbContract;
  const dbName = testDbName();
  (await openTestDb(dbName, [{ name: "points", keyPath }, OUTBOX_STORE, VERSION_META_STORE])).close();
  const client = createSyncIdbClient({ contract, dbName });
  /** The key as a pull carries it: Float Infinity is the text "Infinity". */
  const wireKey = (x: number | string) => (compound ? [x, "a"] : x);
  const log = (x: number | string, n: number, note = "server") => ({
    model: "Point",
    operation: "update" as const,
    changelogId: changelogId(n),
    keyPath: wireKey(x),
    record: { x, group: "a", note },
  });
  return { client, wireKey, log, points: asAccessors(client.orm)["points"]! };
}

describe("versionMetaKey", () => {
  it("keeps +Infinity, -Infinity, null and finite keys apart, and matches the wire text", () => {
    const ids = [Infinity, -Infinity, null, 0, "Infinity-ish"].map((key) => versionMetaKey("P", key));
    expect(new Set(ids).size).toBe(ids.length);
    expect(versionMetaKey("P", Infinity)).toBe(versionMetaKey("P", "Infinity"));
    expect(versionMetaKey("P", [-Infinity, "a"])).toBe(versionMetaKey("P", ["-Infinity", "a"]));
  });
});

describe.each([false, true])("Float key sync identity (compound: %s)", (compound) => {
  it("tracks +Infinity and -Infinity under separate metadata records", async () => {
    const { client, points } = await setup(compound);
    try {
      await points.create({ x: Infinity, group: "a", note: "up" });
      await points.create({ x: -Infinity, group: "a", note: "down" });
      const metadata = await scanAll(client, "_idb_sync_version_meta");
      expect(metadata).toHaveLength(2);
      expect(new Set(metadata.map((meta) => meta["id"])).size).toBe(2);
      const events = await scanAll(client, "_idb_sync_outbox");
      expect(new Set(events.map((event) => event["versionMetaId"])).size).toBe(2);
    } finally {
      await client.close();
    }
  });

  it("halts a pull of an infinite key while that row has a pending local edit, and applies the other", async () => {
    const { client, log, points } = await setup(compound);
    try {
      await points.create({ x: Infinity, group: "a", note: "pending" });
      const result = await applyPull(client, [log("Infinity", 1), log("-Infinity", 2)]);
      expect(result).toMatchObject({ halted: true });
      expect(await scanAll(client, "points")).toMatchObject([{ x: Infinity, note: "pending" }]);

      const second = await setup(compound);
      try {
        await second.points.create({ x: Infinity, group: "a", note: "pending" });
        // The other infinity has no local edit, so its pull applies and gets its own metadata.
        expect(await applyPull(second.client, [second.log("-Infinity", 1)])).toMatchObject({ applied: 1 });
        const rows = await scanAll(second.client, "points");
        expect(rows).toHaveLength(2);
        expect(rows).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ x: Infinity, note: "pending" }),
            expect.objectContaining({ x: -Infinity, note: "server" }),
          ])
        );
        expect(await scanAll(second.client, "_idb_sync_version_meta")).toHaveLength(2);
      } finally {
        await second.client.close();
      }
    } finally {
      await client.close();
    }
  });
});
