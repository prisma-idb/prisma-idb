import { STORAGE_HASH_HEADER, logWithRecordSchema, pushResultSchema } from "../schemas";
import { ContractMismatchError } from "./contract-mismatch-error";
import type { SyncWorkerOptions } from "./sync-worker";
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
      const headers = new Headers(options.headers);
      headers.set("content-type", "application/json");
      headers.set(STORAGE_HASH_HEADER, context.storageHash);
      const response = await fetchRequest(options.pushUrl, {
        method: "POST",
        headers,
        credentials: options.credentials ?? "same-origin",
        redirect: "error",
        body: JSON.stringify({ events }),
        signal,
      });
      return pushResultSchema
        .array()
        .parse(await readResponse(response, "Push"))
        .map(({ id, success, error, retryable, record }) => ({
          id,
          success,
          ...(error === undefined ? {} : { error }),
          ...(retryable === undefined ? {} : { retryable }),
          ...(record === undefined ? {} : { record }),
        }));
    },
    async pullHandler(fromChangelogId, signal, context) {
      const url = new URL(options.pullUrl, globalThis.location?.href);
      // Replace any stale cursor in the endpoint URL; retain its other parameters.
      if (fromChangelogId) url.searchParams.set("since", fromChangelogId);
      else url.searchParams.delete("since");
      const headers = new Headers(options.headers);
      headers.set(STORAGE_HASH_HEADER, context.storageHash);
      const response = await fetchRequest(url.href, {
        headers,
        credentials: options.credentials ?? "same-origin",
        redirect: "error",
        signal,
      });
      return logWithRecordSchema.array().parse(await readResponse(response, "Pull"));
    },
  };
}
