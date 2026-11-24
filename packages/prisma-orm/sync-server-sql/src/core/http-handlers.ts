import { pullRequestQuerySchema, pushRequestBodySchema } from "@prisma-idb/sync-extension-idb/schemas";
import { createSyncServer } from "@prisma-idb/sync-server";
import type { CreateSyncServerOptions, SyncServerContract } from "@prisma-idb/sync-server";
import { encodeWireValues } from "./wire-values";
import { sqlGetKeyField } from "./get-key-field";
import { createSqlSyncAdapter } from "./create-adapter";
import type { ModelWritePolicies } from "./write-policy";
import type { SqlSyncAdapter } from "./create-adapter";

/** A trusted application value, resolved separately for each authenticated request. */
export type SqlSyncResolver<T> = T | ((request: Request) => T | Promise<T>);

/** Creates SQL sync endpoints with the default SQL key resolver and batch limits. */
export interface CreateSqlSyncOptions extends Pick<
  CreateSyncServerOptions,
  "contract" | "clientContract" | "rootModel"
> {
  readonly db: SqlSyncResolver<object>;
  /** Resolve from the authenticated session, never from the request body or URL. */
  readonly scopeKey: SqlSyncResolver<string>;
  readonly maxBatchSize?: number;
  readonly pullLimit?: number;
  /** Per-model client operation and field allowlists, checked before any batch writes. */
  readonly writePolicies?: ModelWritePolicies;
}

/** Fetch-compatible endpoints. In Hono, pass `c.req.raw` as the request. */
export interface SqlSync {
  push(request: Request): Promise<Response>;
  pull(request: Request): Promise<Response>;
}

/** Internal SQL execution settings shared by the two HTTP routes. */
interface HandlerOptions {
  readonly adapter: SqlSyncAdapter;
  readonly contract: SyncServerContract;
  readonly maxBatchSize?: number;
  readonly pullLimit?: number;
}

/** Authenticated application context for one request. */
interface RequestContext {
  readonly db: object;
  readonly scopeKey: string;
}

/** Validates the HTTP push envelope before applying events in the trusted scope. */
async function handlePush(
  { adapter, contract, maxBatchSize }: HandlerOptions,
  request: Request,
  { db, scopeKey }: RequestContext
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
    clientStorageHash: parsed.data.storageHash,
  });
  if (outcome.ok) {
    // A rejected event carries its row's current state, read natively from SQL. The push has
    // already committed, so a record that can't be encoded is dropped from its result rather
    // than failing the response, which would make the client retry events that were applied.
    const models = new Map(parsed.data.events.map((event) => [event.id, event.entityType]));
    const results = outcome.results.map((result) => {
      const model = models.get(result.id);
      if (!result.record || model === undefined) return JSON.stringify(result);
      try {
        return JSON.stringify({ ...result, record: encodeWireValues(contract, model, result.record) });
      } catch {
        const { record: _unencodable, ...withoutRecord } = result;
        return JSON.stringify(withoutRecord);
      }
    });
    return new Response(`[${results.join(",")}]`, { headers: { "Content-Type": "application/json" } });
  }
  switch (outcome.reason) {
    case "write-policy-violation":
      return Response.json(outcome, { status: 403 });
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
  { adapter, contract, pullLimit }: HandlerOptions,
  request: Request,
  { db, scopeKey }: RequestContext
): Promise<Response> {
  const parsed = pullRequestQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) {
    return Response.json({ error: "Malformed query parameters", details: parsed.error.issues }, { status: 400 });
  }
  const outcome = await adapter.pull(db, {
    scopeKey,
    lastChangelogId: parsed.data.since || null,
    ...(pullLimit === undefined ? {} : { limit: pullLimit }),
    clientStorageHash: parsed.data.storageHash,
  });
  if (outcome.ok) {
    // A missing record means the row was deleted or revoked, so a log whose record can't be
    // encoded can't be sent without it. Fail the page and name the log instead.
    const logs: string[] = [];
    for (const log of outcome.logs) {
      try {
        logs.push(
          JSON.stringify(log.record ? { ...log, record: encodeWireValues(contract, log.model, log.record) } : log)
        );
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return Response.json(
          { error: `Could not encode changelog entry ${log.changelogId} (${log.model}): ${reason}` },
          { status: 500 }
        );
      }
    }
    return new Response(`{"logs":[${logs.join(",")}],"hasMore":${outcome.hasMore}}`, {
      headers: { "Content-Type": "application/json" },
    });
  }
  switch (outcome.reason) {
    case "contract-mismatch":
      return Response.json(outcome, { status: 409 });
    case "invalid-cursor":
      return Response.json(outcome, { status: 400 });
  }
  throw new Error(`Unhandled pull outcome: ${outcome satisfies never}`);
}

/**
 * Creates SQL sync endpoints bound to the full and projected contracts.
 * Resolvers must authenticate requests and reject unauthenticated callers.
 * Unexpected errors reject so the application's error middleware can handle them.
 */
export function createSqlSync(options: CreateSqlSyncOptions): SqlSync {
  const syncServer = createSyncServer({
    contract: options.contract,
    clientContract: options.clientContract,
    rootModel: options.rootModel,
    getKeyField: sqlGetKeyField,
  });
  const handlers: HandlerOptions = {
    adapter: createSqlSyncAdapter({
      contract: options.contract,
      syncServer,
      ...(options.writePolicies === undefined ? {} : { writePolicies: options.writePolicies }),
    }),
    contract: options.contract,
    ...(options.maxBatchSize === undefined ? {} : { maxBatchSize: options.maxBatchSize }),
    ...(options.pullLimit === undefined ? {} : { pullLimit: options.pullLimit }),
  };
  /** Resolve the session before acquiring a database connection. */
  async function context(request: Request): Promise<RequestContext> {
    const scopeKey = typeof options.scopeKey === "function" ? await options.scopeKey(request) : options.scopeKey;
    const db = typeof options.db === "function" ? await options.db(request) : options.db;
    return { db, scopeKey };
  }
  return {
    push: async (request) => handlePush(handlers, request, await context(request)),
    pull: async (request) => {
      const response = await handlePull(handlers, request, await context(request));
      // The URL does not identify the authenticated user whose records it contains.
      response.headers.set("Cache-Control", "no-store");
      return response;
    },
  };
}
