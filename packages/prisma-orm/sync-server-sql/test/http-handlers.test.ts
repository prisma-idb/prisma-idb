import { describe, expect, it } from "vitest";
import { createSyncFetchHandlers, ContractMismatchError } from "@prisma-idb/sync-extension-idb/client";
import { STORAGE_HASH_HEADER } from "@prisma-idb/sync-extension-idb/schemas";
import { createSqlSyncHandlers } from "../src/exports/index";
import { createSqlSyncAdapter } from "../src/core/create-adapter";
import { testContract, testDb, testSyncServer } from "./helpers";

const handlers = createSqlSyncHandlers({
  adapter: createSqlSyncAdapter({ contract: testContract, syncServer: testSyncServer }),
  maxBatchSize: 1,
  pullLimit: 1,
});
const context = { storageHash: testSyncServer.clientStorageHash };

/** Builds real HTTP requests with the fixture's client storage hash. */
async function pushRequest(body: unknown): Promise<Request> {
  return new Request("https://sync.test/push", {
    method: "POST",
    headers: { [STORAGE_HASH_HEADER]: context.storageHash },
    body: JSON.stringify(body),
  });
}

/** Bridges the client transport to real server handlers without opening a network port. */
async function transport(): Promise<typeof fetch> {
  const db = await testDb();
  return async (input, init) => {
    const request = new Request(input, init);
    return handlers[request.method === "POST" ? "push" : "pull"](request, { db, scopeKey: "u1" });
  };
}

describe("sync HTTP handlers", () => {
  it("exchanges a real push and paginated pull while ignoring an untrusted scope", async () => {
    const client = createSyncFetchHandlers({
      pushUrl: "https://sync.test/push",
      pullUrl: "https://sync.test/pull?scopeKey=other&since=stale",
      fetch: await transport(),
    });
    const signal = new AbortController().signal;
    // The transport only needs the public wire fields, not an IndexedDB outbox row.
    const request = await pushRequest({
      scopeKey: "other",
      events: [{ id: "e1", entityType: "User", operation: "create", payload: { id: "u1", name: "Ann" } }],
    });
    const response = await handlers.push(request, { db: await testDb(), scopeKey: "u1" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([{ id: "e1", success: true }]);
    const logs = await client.pullHandler(null, signal, context);
    expect(logs).toMatchObject([{ model: "User", record: { id: "u1", name: "Ann" } }]);
    expect(await client.pullHandler(logs[0]!.changelogId, signal, context)).toEqual([]);

    expect(await client.pushHandler([], signal, context)).toEqual([]);
  });

  it.each([null, "old-contract"])(
    "surfaces %s storage hash refusals as ContractMismatchError for both routes",
    async (storageHash) => {
      const request = new Request("https://sync.test/push", {
        method: "POST",
        ...(storageHash === null ? {} : { headers: { [STORAGE_HASH_HEADER]: storageHash } }),
        body: JSON.stringify({
          events: [{ id: "e1", entityType: "User", operation: "create", payload: { id: "u1", name: "Ann" } }],
        }),
      });
      const db = await testDb();
      const response = await handlers.push(request, { db, scopeKey: "u1" });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        ok: false,
        reason: "contract-mismatch",
        expected: context.storageHash,
      });

      const client = createSyncFetchHandlers({
        pushUrl: "https://sync.test/push",
        pullUrl: "https://sync.test/pull",
        fetch: await transport(),
      });
      const oldContext = { storageHash: storageHash ?? "" };
      const signal = new AbortController().signal;
      await expect(client.pushHandler([], signal, oldContext)).rejects.toBeInstanceOf(ContractMismatchError);
      await expect(client.pullHandler(null, signal, oldContext)).rejects.toBeInstanceOf(ContractMismatchError);
      const accepted = await client.pullHandler(null, signal, context);
      expect(accepted).toEqual([]);
    }
  );

  it("maps malformed JSON, malformed events, duplicate ids, oversized batches and invalid cursors to 400", async () => {
    const trusted = { db: await testDb(), scopeKey: "u1" };
    const invalidJson = await handlers.push(
      new Request("https://sync.test/push", { method: "POST", body: "{" }),
      trusted
    );
    expect(invalidJson.status).toBe(400);
    expect(await invalidJson.json()).toMatchObject({ error: "Invalid JSON body" });
    const malformed = await handlers.push(await pushRequest({ events: [{ operation: "bogus" }] }), trusted);
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: "Malformed request body" });

    const event = { id: "e1", entityType: "User", operation: "create", payload: { id: "u1", name: "Ann" } };
    const large = await handlers.push(await pushRequest({ events: [event, { ...event, id: "e2" }] }), trusted);
    expect(large.status).toBe(400);
    expect(await large.json()).toMatchObject({ reason: "batch-too-large", maxBatchSize: 1 });
    const duplicates = createSqlSyncHandlers({
      adapter: createSqlSyncAdapter({ contract: testContract, syncServer: testSyncServer }),
    });
    const duplicate = await duplicates.push(await pushRequest({ events: [event, event] }), trusted);
    expect(duplicate.status).toBe(400);
    expect(await duplicate.json()).toMatchObject({ reason: "duplicate-event-id" });
    const invalidCursor = await handlers.pull(
      new Request("https://sync.test/pull?since=bad", {
        headers: { [STORAGE_HASH_HEADER]: context.storageHash },
      }),
      trusted
    );
    expect(invalidCursor.status).toBe(400);
    expect(await invalidCursor.json()).toMatchObject({ reason: "invalid-cursor" });
  });
});
