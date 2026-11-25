import { describe, expect, it } from "vitest";
import { defineContract } from "@prisma-idb/family-idb/contract-ts";
import idbFamilyPack from "@prisma-idb/family-idb/pack";
import idbTargetPack from "@prisma-idb/target-idb/pack";
import type { IdbContract } from "@prisma-idb/client-idb/orm";
import { createSyncFetchHandlers } from "../src/core/fetch-handlers";
import { ContractMismatchError } from "../src/core/contract-mismatch-error";
import type { OutboxEvent } from "../src/types";

const contract = defineContract({
  family: idbFamilyPack,
  target: idbTargetPack,
  models: {
    Asset: {
      store: "assets",
      key: "id",
      fields: { id: "Bytes", size: "BigInt", sizes: "BigInt[]", checksum: "Bytes?", at: "DateTime" },
    },
  },
}) as unknown as IdbContract;
const context = { storageHash: "client-contract", contract };

/** An outbox row as the worker hands it to the push handler. */
function outboxEvent(id: string, operation: string, payload: unknown): OutboxEvent {
  return {
    id,
    entityType: "Asset",
    operation,
    payload,
    createdAt: new Date(0),
    synced: false,
    syncedAt: null,
    lastAttemptedAt: null,
    tries: 0,
    lastError: null,
    migrationError: null,
    retryable: true,
    versionMetaId: null,
  };
}

/** Network boundary that echoes the public request properties for assertions. */
function echoRequest(input: string | URL | Request, init?: RequestInit): Request {
  return new Request(input, init);
}

describe("fetch sync handlers", () => {
  it("sends the storage hash, authentication and cancellation on both requests, forbidding redirects and retaining endpoint parameters", async () => {
    let controller = new AbortController();
    const client = createSyncFetchHandlers({
      pushUrl: "https://sync.test/push",
      pullUrl: "https://sync.test/pull?tenant=app&since=old&storageHash=stale",
      credentials: "include",
      headers: { authorization: "Bearer app-token" },
      fetch: async (input, init) => {
        const request = echoRequest(input, init);
        expect(request.headers.has("x-storage-hash")).toBe(false);
        expect(request.headers.get("authorization")).toBe("Bearer app-token");
        expect(request.credentials).toBe("include");
        expect(request.redirect).toBe("error");
        controller.abort();
        expect(request.signal.aborted).toBe(true);
        if (request.method === "POST") {
          expect(request.headers.get("content-type")).toBe("application/json");
          expect(await request.json()).toEqual({ storageHash: context.storageHash, events: [] });
        } else {
          const url = new URL(request.url);
          expect(url.searchParams.getAll("storageHash")).toEqual([context.storageHash]);
          expect(url.searchParams.get("tenant")).toBe("app");
          expect(url.searchParams.getAll("since")).toEqual(["cursor+/?"]);
        }
        return Response.json(request.method === "POST" ? [] : { logs: [], hasMore: true });
      },
    });
    expect(await client.pushHandler([], controller.signal, context)).toEqual([]);
    controller = new AbortController();
    expect(await client.pullHandler("cursor+/?", controller.signal, context)).toEqual({ logs: [], hasMore: true });
  });

  it("sends BigInt, Bytes and DateTime values in the wire form the server revives", async () => {
    let body: unknown;
    const client = createSyncFetchHandlers({
      pushUrl: "https://sync.test/push",
      pullUrl: "https://sync.test/pull",
      fetch: async (input, init) => {
        body = await new Request(input, init).json();
        return Response.json([]);
      },
    });
    const id = new Uint8Array([1, 2, 255]);
    const at = new Date("2026-01-01T00:00:00.000Z");
    await client.pushHandler(
      [
        outboxEvent("c", "create", { id, size: 9007199254740993n, sizes: [1n, 2n], checksum: null, at }),
        outboxEvent("u", "update", { key: id, patch: { size: 1n, checksum: new Uint8Array([0]) } }),
        outboxEvent("d", "delete", { key: id }),
      ],
      new AbortController().signal,
      context
    );
    expect((body as { events: { payload: unknown }[] }).events.map((event) => event.payload)).toEqual([
      { id: "AQL/", size: "9007199254740993", sizes: ["1", "2"], checksum: null, at: "2026-01-01T00:00:00.000Z" },
      { key: "AQL/", patch: { size: "1", checksum: "AA==" } },
      { key: "AQL/" },
    ]);
  });

  it("fails an event a codec can't encode on its own, and still sends the rest of the batch", async () => {
    let body: unknown;
    const client = createSyncFetchHandlers({
      pushUrl: "https://sync.test/push",
      pullUrl: "https://sync.test/pull",
      fetch: async (input, init) => {
        body = await new Request(input, init).json();
        return Response.json([{ id: "d", success: true }]);
      },
    });
    const results = await client.pushHandler(
      [
        // The DateTime codec throws on an invalid date.
        outboxEvent("c", "create", { id: new Uint8Array([2]), size: 1n, sizes: [], checksum: null, at: new Date(NaN) }),
        outboxEvent("d", "delete", { key: new Uint8Array([1]) }),
      ],
      new AbortController().signal,
      context
    );
    expect((body as { events: { id: string; payload: unknown }[] }).events).toEqual([
      expect.objectContaining({ id: "d", payload: { key: "AQ==" } }),
    ]);
    expect(results).toEqual([
      { id: "c", success: false, retryable: false, error: expect.stringContaining('create event for "Asset"') },
      { id: "d", success: true },
    ]);
  });

  it("sends no request when every event in the batch is unencodable", async () => {
    let requests = 0;
    const client = createSyncFetchHandlers({
      pushUrl: "https://sync.test/push",
      pullUrl: "https://sync.test/pull",
      fetch: async () => {
        requests++;
        return Response.json([]);
      },
    });
    const results = await client.pushHandler(
      [outboxEvent("c", "create", { id: new Uint8Array([2]), size: 1n, sizes: [], checksum: null, at: new Date(NaN) })],
      new AbortController().signal,
      context
    );
    expect(requests).toBe(0);
    expect(results).toEqual([expect.objectContaining({ id: "c", success: false, retryable: false })]);
  });

  it("throws for a request context without a contract instead of sending unencoded values", async () => {
    let requests = 0;
    const client = createSyncFetchHandlers({
      pushUrl: "https://sync.test/push",
      pullUrl: "https://sync.test/pull",
      fetch: async () => {
        requests++;
        return Response.json([]);
      },
    });
    const handContext = { storageHash: "client-contract" } as unknown as typeof context;
    await expect(
      client.pushHandler(
        [outboxEvent("d", "delete", { key: new Uint8Array([1]) })],
        new AbortController().signal,
        handContext
      )
    ).rejects.toThrow("needs the client contract");
    expect(requests).toBe(0);
  });

  it("encodes a bulk delete's BigInt and Bytes range bounds and fails an unknown model's bigint on its own", async () => {
    let body: unknown;
    const client = createSyncFetchHandlers({
      pushUrl: "https://sync.test/push",
      pullUrl: "https://sync.test/pull",
      fetch: async (input, init) => {
        body = await new Request(input, init).json();
        return Response.json([{ id: "r", success: true }]);
      },
    });
    const range = { lower: new Uint8Array([1]), upper: new Uint8Array([2]), lowerOpen: false, upperOpen: true };
    const gone = { ...outboxEvent("g", "create", { id: "a", size: 5n }), entityType: "Gone" };
    const results = await client.pushHandler(
      [outboxEvent("r", "delete", { key: range }), gone],
      new AbortController().signal,
      context
    );
    expect((body as { events: { payload: unknown }[] }).events).toHaveLength(1);
    expect((body as { events: { payload: unknown }[] }).events[0]?.payload).toEqual({
      key: { lower: "AQ==", upper: "Ag==", lowerOpen: false, upperOpen: true },
    });
    expect(results).toEqual([
      { id: "g", success: false, retryable: false, error: expect.stringContaining("bigint") },
      { id: "r", success: true },
    ]);
  });

  it("fails an event whose payload JSON.stringify rejects without rejecting the whole push", async () => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    const client = createSyncFetchHandlers({
      pushUrl: "https://sync.test/push",
      pullUrl: "https://sync.test/pull",
      fetch: async () => Response.json([{ id: "d", success: true }]),
    });
    const results = await client.pushHandler(
      [outboxEvent("c", "create", circular), outboxEvent("d", "delete", { key: new Uint8Array([1]) })],
      new AbortController().signal,
      context
    );
    expect(results).toEqual([
      { id: "c", success: false, retryable: false, error: expect.stringContaining("circular") },
      { id: "d", success: true },
    ]);
  });

  it.each([409, 401, 500])("handles HTTP %s before parsing a non-JSON body", async (status) => {
    const client = createSyncFetchHandlers({
      pushUrl: "https://sync.test/push",
      pullUrl: "https://sync.test/pull",
      fetch: async () => new Response("refused", { status }),
    });
    const signal = new AbortController().signal;
    for (const request of [
      () => client.pushHandler([], signal, context),
      () => client.pullHandler(null, signal, context),
    ]) {
      if (status === 409) await expect(request()).rejects.toBeInstanceOf(ContractMismatchError);
      else await expect(request()).rejects.toThrow(`failed: ${status}`);
    }
  });
});
