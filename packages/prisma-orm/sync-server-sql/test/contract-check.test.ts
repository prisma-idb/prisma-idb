import { describe, expect, it } from "vitest";
import { computeStorageHash } from "@prisma/orm-framework/contract/hashing";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import idbFamily from "@prisma-idb/family-idb/pack";
import idbTarget from "@prisma-idb/target-idb/pack";
import type { IdbContract } from "@prisma-idb/client-idb/orm";
import { idbSyncExtension } from "@prisma-idb/sync-extension-idb/control";
import { createSyncServer } from "@prisma-idb/sync-server";
import { sqlGetKeyField } from "../src/core/get-key-field";
import { createSqlSyncAdapter } from "../src/core/create-adapter";
import { testContract, testDb, testSyncServer } from "./helpers";

const gated = createSqlSyncAdapter({ contract: testContract, syncServer: testSyncServer });
const ungated = createSqlSyncAdapter({
  contract: testContract,
  syncServer: testSyncServer,
  contractCheck: "off",
});

const events = [{ id: "e1", entityType: "User", operation: "create" as const, payload: { id: "u1", name: "Ann" } }];

/** A database that fails the test on any use, to prove a refused request never reaches it. */
const untouchedDb = new Proxy({}, { get: () => expect.unreachable("the database was used") });

/** Builds the client JSON with the sync extension's emitted stores included. */
function clientContract(names = ["Ann"]) {
  const contract = defineContract({
    family: idbFamily,
    target: idbTarget,
    enums: { Name: names },
    models: { User: { store: "users", key: "id", fields: { id: "String", name: "Name" } } },
  });
  const { storageHash: _hash, ...storage } = contract.storage;
  storage.stores = {
    ...storage.stores,
    ...(idbSyncExtension.contractSpace.contractJson as IdbContract).storage.stores,
  };
  return {
    ...contract,
    storage: { ...storage, storageHash: computeStorageHash({ target: "idb", targetFamily: "idb", storage }) },
  };
}

describe("contract check gate", () => {
  it("refuses pull and applyPush on a different storage hash before touching the database", async () => {
    const expected = testSyncServer.clientStorageHash;
    const refusal = { ok: false, reason: "contract-mismatch", expected };
    const clientStorageHash = "old-client";

    expect(await gated.pull(untouchedDb, { scopeKey: "u1", clientStorageHash })).toEqual(refusal);
    expect(await gated.applyPush(untouchedDb, { scopeKey: "u1", events, clientStorageHash })).toEqual(refusal);
  });

  it("refuses a request that sends no storage hash", async () => {
    expect(await gated.pull(untouchedDb, { scopeKey: "u1" })).toMatchObject({ reason: "contract-mismatch" });
    expect(await gated.pull(untouchedDb, { scopeKey: "u1", clientStorageHash: null })).toMatchObject({
      reason: "contract-mismatch",
    });
    expect(await gated.applyPush(untouchedDb, { scopeKey: "u1", events })).toMatchObject({
      reason: "contract-mismatch",
    });
    expect(await gated.applyPush(untouchedDb, { scopeKey: "u1", events, clientStorageHash: null })).toMatchObject({
      reason: "contract-mismatch",
    });
  });

  it("applies nothing from a refused push, and serves the same push once the storage hash matches", async () => {
    const db = await testDb();
    await gated.applyPush(db, { scopeKey: "u1", events, clientStorageHash: "old-client" });
    expect(await ungated.pull(db, { scopeKey: "u1" })).toEqual({ ok: true, logs: [] });

    const clientStorageHash = testSyncServer.clientStorageHash;
    expect(await gated.applyPush(db, { scopeKey: "u1", events, clientStorageHash })).toEqual({
      ok: true,
      results: [{ id: "e1", success: true }],
    });
    const pulled = await gated.pull(db, { scopeKey: "u1", clientStorageHash });
    expect(pulled).toMatchObject({ ok: true, logs: [{ model: "User", operation: "create" }] });
  });

  it("accepts the same emitted client JSON and refuses an enum-value change", async () => {
    const emitted = clientContract();
    // Model the server and browser loading separate copies of one contract.json.
    const serverCopy = JSON.parse(JSON.stringify(emitted)) as typeof emitted;
    const browserCopy = JSON.parse(JSON.stringify(emitted)) as typeof emitted;
    expect(Object.keys(browserCopy.storage.stores)).toEqual(
      expect.arrayContaining(["users", "_idb_sync_outbox", "_idb_sync_version_meta"])
    );
    const syncServer = createSyncServer({
      contract: testContract,
      clientContract: serverCopy,
      rootModel: "User",
      getKeyField: sqlGetKeyField,
    });
    const adapter = createSqlSyncAdapter({ contract: testContract, syncServer });
    const db = await testDb();
    const input = { scopeKey: "u1", clientStorageHash: browserCopy.storage.storageHash };

    expect(await adapter.applyPush(db, { ...input, events })).toMatchObject({
      ok: true,
      results: [{ id: "e1", success: true }],
    });
    expect(await adapter.pull(db, input)).toMatchObject({
      ok: true,
      logs: [{ model: "User", record: { id: "u1", name: "Ann" } }],
    });
    // The SQL contract describes a different storage family, even for these same rows.
    expect(
      await adapter.pull(untouchedDb, {
        scopeKey: "u1",
        clientStorageHash: testContract.storage.storageHash,
      })
    ).toMatchObject({ reason: "contract-mismatch", expected: input.clientStorageHash });

    const clientStorageHash = clientContract(["Ann", "Bea"]).storage.storageHash;
    expect(await adapter.pull(untouchedDb, { scopeKey: "u1", clientStorageHash })).toMatchObject({
      reason: "contract-mismatch",
      expected: input.clientStorageHash,
    });
    expect(await adapter.applyPush(untouchedDb, { scopeKey: "u1", events, clientStorageHash })).toMatchObject({
      reason: "contract-mismatch",
      expected: input.clientStorageHash,
    });
  });

  it('skips the check when the app opts out with "off"', async () => {
    const db = await testDb();
    expect(await ungated.applyPush(db, { scopeKey: "u1", events })).toMatchObject({ ok: true });
    expect(await ungated.pull(db, { scopeKey: "u1" })).toMatchObject({ ok: true });
    expect(await ungated.pull(db, { scopeKey: "u1", clientStorageHash: "old-client" })).toMatchObject({ ok: true });
  });
});
