import { describe, expect, it } from "vitest";
import { createSyncFetchHandlers } from "../src/core/fetch-handlers";
import { ContractMismatchError } from "../src/core/contract-mismatch-error";
import { STORAGE_HASH_HEADER } from "../src/schemas";

const context = { storageHash: "client-contract" };

/** Network boundary that echoes the public request properties for assertions. */
function echoRequest(input: string | URL | Request, init?: RequestInit): Request {
  return new Request(input, init);
}

describe("fetch sync handlers", () => {
  it("sends the storage hash, authentication and cancellation on both requests, forbidding redirects and retaining endpoint parameters", async () => {
    let controller = new AbortController();
    const client = createSyncFetchHandlers({
      pushUrl: "https://sync.test/push",
      pullUrl: "https://sync.test/pull?tenant=app&since=old",
      credentials: "include",
      headers: { authorization: "Bearer app-token", [STORAGE_HASH_HEADER]: "stale" },
      fetch: async (input, init) => {
        const request = echoRequest(input, init);
        expect(request.headers.get(STORAGE_HASH_HEADER)).toBe("client-contract");
        expect(request.headers.get("authorization")).toBe("Bearer app-token");
        expect(request.credentials).toBe("include");
        expect(request.redirect).toBe("error");
        controller.abort();
        expect(request.signal.aborted).toBe(true);
        if (request.method === "POST") {
          expect(request.headers.get("content-type")).toBe("application/json");
          expect(await request.json()).toEqual({ events: [] });
        } else {
          const url = new URL(request.url);
          expect(url.searchParams.get("tenant")).toBe("app");
          expect(url.searchParams.getAll("since")).toEqual(["cursor+/?"]);
        }
        return Response.json([]);
      },
    });
    expect(await client.pushHandler([], controller.signal, context)).toEqual([]);
    controller = new AbortController();
    expect(await client.pullHandler("cursor+/?", controller.signal, context)).toEqual([]);
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
