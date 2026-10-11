import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { createIdbClient } from "@prisma-idb/client-idb/client";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import idbFamily from "@prisma-idb/family-idb/pack";
import idbTarget from "@prisma-idb/target-idb/pack";
import { contractSpaceFromJson } from "@prisma/orm-toolchain/migration-tools/spaces";
import { validateRecord } from "@prisma-idb/target-idb/runtime";
import { createAutoMigratingSyncIdbClient } from "../src/exports/client";
import { idbSyncExtension } from "../src/exports/control";
import { syncContract } from "../src/contract";
import previousContract from "../migrations/snapshots/20005ac86953ae2786743ec34740cfeae4a653c80c9d7ad7f387bc81c73b87cf/contract.json" with { type: "json" };
import { buildContractSpaceFixture } from "./_contract-space-fixture";
import { asAccessors, scanAll } from "./helpers";

const contract = defineContract({
  family: idbFamily,
  target: idbTarget,
  models: { User: { store: "users", key: "id", fields: { id: "String", name: "String" } } },
});

const previousExtension = {
  ...idbSyncExtension,
  contractSpace: contractSpaceFromJson({
    contractJson: previousContract,
    migrations: idbSyncExtension.contractSpace.migrations.slice(0, 2),
    headRef: { hash: previousContract.storage.storageHash, invariants: [] },
  }),
};

describe("nullable outbox field migration", () => {
  it.each([true, false])(
    "reads missing fields as null and completes old-event pushes (success: %s)",
    async (success) => {
      const factory = new IDBFactory();
      const options = { factory, dbName: "outbox-field-migration", contractSpace: buildContractSpaceFixture(contract) };
      const old = await createAutoMigratingSyncIdbClient({ ...options, extensions: [previousExtension] });
      await asAccessors(old.orm)["users"]!.create({ id: "u1", name: "Alice" });
      const [queued] = await scanAll(old, "_idb_sync_outbox");
      const legacy = { ...queued! };
      delete legacy["migrationError"];
      delete legacy["versionMetaId"];
      await old.withTransaction(["_idb_sync_outbox"], async (scope) => {
        await scope.execute({ kind: "put", storeName: "_idb_sync_outbox", record: legacy } as never);
      });
      await old.close();

      const migration = idbSyncExtension.contractSpace.migrations[2]!;
      expect(migration.metadata.from).toBe(previousContract.storage.storageHash);
      expect(migration.metadata.to).toBe(syncContract.storage.storageHash);
      expect(migration.metadata.to).not.toBe(migration.metadata.from);
      expect(migration.ops).toEqual([]);

      const current = await createAutoMigratingSyncIdbClient({ ...options, extensions: [idbSyncExtension] });
      const outboxReader = createIdbClient({ factory, dbName: options.dbName, contract: syncContract });
      try {
        expect(await scanAll(current, "_idb_sync_outbox")).toEqual([legacy]);
        const row = await asAccessors(outboxReader.orm)["_idb_sync_outbox"]!.findUnique(legacy["id"]);
        expect(row).toEqual({ ...legacy, migrationError: null, versionMetaId: null });
        expect(validateRecord(syncContract, "OutboxEvent", row!)).toEqual({ ok: true });
        expect(await scanAll(current, "_idb_sync_outbox")).toEqual([legacy]);
        const markers = await scanAll(current, "_prisma_next_marker");
        expect(markers.find((marker) => marker["space"] === "idb-sync")?.["storageHash"]).toBe(
          syncContract.storage.storageHash
        );

        const pushed: unknown[] = [];
        const worker = current.createSyncWorker({
          pushHandler: async (events) => {
            pushed.push(...events);
            return events.map((event) =>
              success
                ? { id: event.id, success: true }
                : { id: event.id, success: false, retryable: false, error: "rejected" }
            );
          },
          pullHandler: async () => [],
        });
        await worker.forceSync();
        expect(pushed).toEqual([{ ...legacy, migrationError: null, versionMetaId: null }]);
        expect(await scanAll(current, "_idb_sync_outbox")).toEqual([
          expect.objectContaining(
            success ? { synced: true } : { synced: false, retryable: false, lastError: "rejected" }
          ),
        ]);
      } finally {
        await outboxReader.close();
        await current.close();
      }
    }
  );
});
