import { pullResponseSchema, pushResultSchema } from "../schemas";
import { ContractMismatchError } from "./contract-mismatch-error";
import { toWireEvent, WireEncodeError } from "./wire-event";
import type { SyncWorkerOptions } from "./sync-worker";
import type { OutboxEvent, PushResult } from "../types";
import type { IdbContract } from "@prisma-idb/client-idb/orm";

/** HTTP transport configuration for a sync worker. Relative URLs require a browser location. */
export interface SyncFetchHandlersOptions {
  readonly pushUrl: string;
  readonly pullUrl: string;
  /** Custom transport, for example to attach a refreshed authorization token. */
  readonly fetch?: typeof globalThis.fetch;
  readonly headers?: HeadersInit;
  /** Defaults to fetch's same-origin credentials policy. */
  readonly credentials?: RequestCredentials;
}

/** Ready to spread into `createSyncWorker` or a managed sync client's worker options. */
export type SyncFetchHandlers = Pick<SyncWorkerOptions<IdbContract>, "pushHandler" | "pullHandler">;

/** Rejects mismatches before reading the body, including non-JSON 409 responses. */
async function readResponse(response: Response, operation: string): Promise<unknown> {
  if (response.status === 409) throw new ContractMismatchError();
  if (!response.ok) throw new Error(`${operation} failed: ${response.status}`);
  return response.json();
}

/**
 * Creates fetch handlers that send the worker's client storage hash and surface
 * HTTP 409 as ContractMismatchError. The worker then emits `contractmismatch`
 * without advancing its cursor or consuming queued writes.
 */
export function createSyncFetchHandlers(options: SyncFetchHandlersOptions): SyncFetchHandlers {
  const fetchRequest = options.fetch ?? globalThis.fetch.bind(globalThis);
  return {
    async pushHandler(events, signal, context) {
      // An event that can't be encoded fails on its own, without a request, so the rest of the batch still syncs.
      const wireEvents: OutboxEvent[] = [];
      const unencodable: PushResult[] = [];
      for (const event of events) {
        try {
          wireEvents.push(toWireEvent(context.contract, event));
        } catch (error) {
          if (!(error instanceof WireEncodeError)) throw error;
          unencodable.push({ id: event.id, success: false, error: error.message, retryable: false });
        }
      }
      if (events.length > 0 && wireEvents.length === 0) return unencodable;
      const headers = new Headers(options.headers);
      headers.set("content-type", "application/json");
      const response = await fetchRequest(options.pushUrl, {
        method: "POST",
        headers,
        credentials: options.credentials ?? "same-origin",
        redirect: "error",
        body: JSON.stringify({
          storageHash: context.storageHash,
          events: wireEvents,
        }),
        signal,
      });
      const results = pushResultSchema
        .array()
        .parse(await readResponse(response, "Push"))
        .map(({ id, success, error, retryable, record }) => ({
          id,
          success,
          ...(error === undefined ? {} : { error }),
          ...(retryable === undefined ? {} : { retryable }),
          ...(record === undefined ? {} : { record }),
        }));
      return [...unencodable, ...results];
    },
    async pullHandler(fromChangelogId, signal, context) {
      const url = new URL(options.pullUrl, globalThis.location?.href);
      // Replace any stale cursor in the endpoint URL; retain its other parameters.
      if (fromChangelogId) url.searchParams.set("since", fromChangelogId);
      else url.searchParams.delete("since");
      url.searchParams.set("storageHash", context.storageHash);
      const response = await fetchRequest(url.href, {
        headers: new Headers(options.headers),
        credentials: options.credentials ?? "same-origin",
        redirect: "error",
        signal,
      });
      return pullResponseSchema.parse(await readResponse(response, "Pull"));
    },
  };
}
