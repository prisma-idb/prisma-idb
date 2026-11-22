import { describe, expect, it } from "vitest";
import { createSyncFetchHandlers, ContractMismatchError } from "@prisma-idb/sync-extension-idb/client";
import type { IdbContract } from "@prisma-idb/client-idb/orm";
import { createSqlSync } from "../src/exports/index";
import {
  testBigClientContract,
  testBigSyncServer,
  testClientContract,
  testContract,
  testDb,
  testSyncServer,
} from "./helpers";

const handlers = createSqlSync({
  contract: testContract,
  clientContract: testClientContract,
  rootModel: "User",
  db: testDb,
  scopeKey: "u1",
  maxBatchSize: 1,
  pullLimit: 1,
});
// These tests push no events through the client transport, so it never reads the contract's fields.
const context = {
  storageHash: testSyncServer.clientStorageHash,
  contract: testClientContract as unknown as IdbContract,
};

/** Builds real HTTP requests with the fixture's client storage hash. */
async function pushRequest(body: Record<string, unknown>): Promise<Request> {
  return new Request("https://sync.test/push", {
    method: "POST",
    body: JSON.stringify({ storageHash: context.storageHash, ...body }),
  });
}

/** Bridges the client transport to real server handlers without opening a network port. */
async function transport(): Promise<typeof fetch> {
  return async (input, init) => {
    const request = new Request(input, init);
    return handlers[request.method === "POST" ? "push" : "pull"](request);
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
    const response = await handlers.push(request);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([{ id: "e1", success: true }]);
    const pullResponse = await handlers.pull(new Request(`https://sync.test/pull?storageHash=${context.storageHash}`));
    expect(pullResponse.headers.get("cache-control")).toBe("no-store");
    const { logs } = await client.pullHandler(null, signal, context);
    expect(logs).toMatchObject([{ model: "User", record: { id: "u1", name: "Ann" } }]);
    expect(await client.pullHandler(logs[0]!.changelogId, signal, context)).toEqual({ logs: [], hasMore: false });

    expect(await client.pushHandler([], signal, context)).toEqual([]);
  });

  it("resolves each authenticated request's scope without reusing another user's records", async () => {
    const scoped = createSqlSync({
      contract: testContract,
      clientContract: testClientContract,
      rootModel: "User",
      db: await testDb(),
      scopeKey: async (request) => {
        const token = request.headers.get("authorization");
        if (!token) throw new Error("Unauthorized");
        return token.slice("Bearer ".length);
      },
    });
    for (const id of ["u1", "u2"]) {
      const request = await pushRequest({
        scopeKey: "other",
        events: [{ id: `event-${id}`, entityType: "User", operation: "create", payload: { id, name: id } }],
      });
      request.headers.set("authorization", `Bearer ${id}`);
      expect(await (await scoped.push(request)).json()).toEqual([{ id: `event-${id}`, success: true }]);
    }
    for (const id of ["u1", "u2"]) {
      const response = await scoped.pull(
        new Request(`https://sync.test/pull?storageHash=${context.storageHash}`, {
          headers: { authorization: `Bearer ${id}` },
        })
      );
      expect(await response.json()).toMatchObject({ logs: [{ record: { id, name: id } }], hasMore: false });
    }
    await expect(scoped.pull(new Request("https://sync.test/pull"))).rejects.toThrow("Unauthorized");
  });

  it.each(["", "old-contract"])(
    "surfaces %s storage hash refusals as ContractMismatchError for both routes",
    async (storageHash) => {
      const request = new Request("https://sync.test/push", {
        method: "POST",
        body: JSON.stringify({
          storageHash,
          events: [{ id: "e1", entityType: "User", operation: "create", payload: { id: "u1", name: "Ann" } }],
        }),
      });
      const response = await handlers.push(request);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        ok: false,
        reason: "contract-mismatch",
        expected: context.storageHash,
      });

      const pullResponse = await handlers.pull(new Request(`https://sync.test/pull?storageHash=${storageHash}`));
      expect(pullResponse.status).toBe(409);
      expect(pullResponse.headers.get("cache-control")).toBe("no-store");

      const client = createSyncFetchHandlers({
        pushUrl: "https://sync.test/push",
        pullUrl: "https://sync.test/pull",
        fetch: await transport(),
      });
      const oldContext = { ...context, storageHash };
      const signal = new AbortController().signal;
      await expect(client.pushHandler([], signal, oldContext)).rejects.toBeInstanceOf(ContractMismatchError);
      await expect(client.pullHandler(null, signal, oldContext)).rejects.toBeInstanceOf(ContractMismatchError);
      const accepted = await client.pullHandler(null, signal, context);
      expect(accepted).toEqual({ logs: [], hasMore: false });
    }
  );

  it("sends BigInt values in pulled and rejected records as strings instead of failing to serialize", async () => {
    const big = createSqlSync({
      contract: testContract,
      clientContract: testBigClientContract,
      rootModel: "BigUser",
      db: testDb,
      scopeKey: "1",
    });
    const storageHash = testBigSyncServer.clientStorageHash;
    const push = async (events: unknown[]) =>
      big.push(
        new Request("https://sync.test/push", { method: "POST", body: JSON.stringify({ storageHash, events }) })
      );
    const created = await push([
      { id: "root", entityType: "BigUser", operation: "create", payload: { id: "1", name: "Ann" } },
      { id: "item", entityType: "BigItem", operation: "create", payload: { id: "11", ownerId: "1", name: "first" } },
    ]);
    expect(await created.json()).toEqual([
      { id: "root", success: true },
      { id: "item", success: true },
    ]);

    const pulled = await big.pull(new Request(`https://sync.test/pull?storageHash=${storageHash}`));
    expect(pulled.status).toBe(200);
    const { logs } = (await pulled.json()) as { logs: { record: unknown }[] };
    expect(logs.map((log) => log.record)).toEqual([
      { id: "1", name: "Ann" },
      { id: "11", ownerId: "1", name: "first" },
    ]);

    // Moving the item to another owner is refused; the result carries the server's row.
    const rejected = await push([
      { id: "move", entityType: "BigItem", operation: "update", payload: { key: "11", patch: { ownerId: "2" } } },
    ]);
    expect(await rejected.json()).toEqual([
      {
        id: "move",
        success: false,
        error: "SCOPE_VIOLATION",
        retryable: false,
        record: { id: "11", ownerId: "1", name: "first" },
      },
    ]);
  });

  it("maps malformed JSON, malformed events, duplicate ids, oversized batches and invalid cursors to 400", async () => {
    const invalidJson = await handlers.push(new Request("https://sync.test/push", { method: "POST", body: "{" }));
    expect(invalidJson.status).toBe(400);
    expect(await invalidJson.json()).toMatchObject({ error: "Invalid JSON body" });
    const malformed = await handlers.push(await pushRequest({ events: [{ operation: "bogus" }] }));
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: "Malformed request body" });

    for (const storageHash of [undefined, null, 42]) {
      const missingHash = await handlers.push(await pushRequest({ storageHash, events: [] }));
      expect(missingHash.status).toBe(400);
    }
    const missingQueryHash = await handlers.pull(new Request("https://sync.test/pull"));
    expect(missingQueryHash.status).toBe(400);
    expect(missingQueryHash.headers.get("cache-control")).toBe("no-store");

    const event = { id: "e1", entityType: "User", operation: "create", payload: { id: "u1", name: "Ann" } };
    const large = await handlers.push(await pushRequest({ events: [event, { ...event, id: "e2" }] }));
    expect(large.status).toBe(400);
    expect(await large.json()).toMatchObject({ reason: "batch-too-large", maxBatchSize: 1 });
    const duplicates = createSqlSync({
      contract: testContract,
      clientContract: testClientContract,
      rootModel: "User",
      db: testDb,
      scopeKey: "u1",
    });
    const duplicate = await duplicates.push(await pushRequest({ events: [event, event] }));
    expect(duplicate.status).toBe(400);
    expect(await duplicate.json()).toMatchObject({ reason: "duplicate-event-id" });
    const invalidCursor = await handlers.pull(
      new Request(`https://sync.test/pull?since=bad&storageHash=${context.storageHash}`)
    );
    expect(invalidCursor.headers.get("cache-control")).toBe("no-store");
    expect(invalidCursor.status).toBe(400);
    expect(await invalidCursor.json()).toMatchObject({ reason: "invalid-cursor" });
  });
});
