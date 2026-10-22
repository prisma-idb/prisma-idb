import { STORAGE_HASH_HEADER, pushRequestBodySchema } from "@prisma-idb/sync-extension-idb/schemas";
import type { SqlSyncAdapter } from "./create-adapter";

/** Configuration shared by the fetch-compatible push and pull endpoints. */
export interface SqlSyncHandlersOptions {
  readonly adapter: SqlSyncAdapter;
  /** Maximum events accepted in one push. Defaults to the adapter's limit. */
  readonly maxBatchSize?: number;
  /** Maximum changelog rows returned by one pull. Defaults to the adapter's limit. */
  readonly pullLimit?: number;
}

/** Trusted application context, resolved after authenticating the request. */
export interface SqlSyncRequestContext {
  readonly db: unknown;
  /** Resolve from the authenticated session, never from the request body or URL. */
  readonly scopeKey: string;
}

/** Fetch-compatible endpoints. In Hono, pass `c.req.raw` as the request. */
export interface SqlSyncHandlers {
  push(request: Request, context: SqlSyncRequestContext): Promise<Response>;
  pull(request: Request, context: SqlSyncRequestContext): Promise<Response>;
}

/** Validates the HTTP push envelope before applying events in the trusted scope. */
async function handlePush(
  { adapter, maxBatchSize }: SqlSyncHandlersOptions,
  request: Request,
  { db, scopeKey }: SqlSyncRequestContext
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = pushRequestBodySchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Malformed request body", details: parsed.error.issues }, { status: 400 });
  }
  const outcome = await adapter.applyPush(db, {
    events: parsed.data.events,
    scopeKey,
    ...(maxBatchSize === undefined ? {} : { maxBatchSize }),
    clientStorageHash: request.headers.get(STORAGE_HASH_HEADER),
  });
  if (outcome.ok) return Response.json(outcome.results);
  switch (outcome.reason) {
    case "contract-mismatch":
      return Response.json(outcome, { status: 409 });
    case "batch-too-large":
    case "duplicate-event-id":
      return Response.json(outcome, { status: 400 });
  }
  throw new Error(`Unhandled push outcome: ${outcome satisfies never}`);
}

/** Reads the URL cursor and maps pull outcomes to HTTP responses. */
async function handlePull(
  { adapter, pullLimit }: SqlSyncHandlersOptions,
  request: Request,
  { db, scopeKey }: SqlSyncRequestContext
): Promise<Response> {
  const outcome = await adapter.pull(db, {
    scopeKey,
    lastChangelogId: new URL(request.url).searchParams.get("since") || null,
    ...(pullLimit === undefined ? {} : { limit: pullLimit }),
    clientStorageHash: request.headers.get(STORAGE_HASH_HEADER),
  });
  if (outcome.ok) return Response.json(outcome.logs);
  switch (outcome.reason) {
    case "contract-mismatch":
      return Response.json(outcome, { status: 409 });
    case "invalid-cursor":
      return Response.json(outcome, { status: 400 });
  }
  throw new Error(`Unhandled pull outcome: ${outcome satisfies never}`);
}

/**
 * Creates HTTP endpoints around the adapter's contract and ownership checks.
 * Authenticate before calling these handlers. Unexpected database errors reject
 * the promise so the application's normal error middleware can handle them.
 */
export function createSqlSyncHandlers(options: SqlSyncHandlersOptions): SqlSyncHandlers {
  return {
    push: (request, context) => handlePush(options, request, context),
    pull: (request, context) => handlePull(options, request, context),
  };
}
