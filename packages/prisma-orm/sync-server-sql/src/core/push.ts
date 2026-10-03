import { idbCodecLookup } from "@prisma-idb/target-idb/runtime";
import { domainModelsAtDefaultNamespace } from "@prisma/orm-framework/contract/types";
import type { GetKeyField, PushCheck, SyncServerContract } from "@prisma-idb/sync-server";
import { nativeJsonCodecs } from "./wire-key";
import { ormRootFor } from "./orm-root";
import { checkAuthorization } from "./authorization";
import { lockScope } from "./scope-lock";
import { nextChangelogId } from "./changelog-id";

/**
 * The fields `applyPushEvent` actually reads out of a push request's event —
 * deliberately not the wire body's full shape (which also carries
 * `entityType`, used by the caller to resolve `model` before calling this).
 * A caller's own request-body type (e.g. the zod-inferred `PushEventBody`
 * from `@prisma-idb/sync-extension-idb/schemas`) is structurally wider
 * than this and satisfies it directly — no import needed here, keeping this
 * package free of any dependency on the browser-side sync package.
 */
export interface SqlPushEvent {
  readonly id: string;
  readonly operation: "create" | "update" | "delete";
  readonly payload: unknown;
}

export interface SqlPushResult {
  readonly id: string;
  readonly success: boolean;
  readonly error?: string;
  readonly retryable?: boolean;
}

/** Internal payload errors preserve diagnostics for direct callers and stable wire codes. */
export class PushPayloadValidationError extends Error {
  constructor(
    readonly code: "RECORD_VALIDATION_FAILURE" | "KEYPATH_VALIDATION_FAILURE",
    message: string
  ) {
    super(message);
  }
}

/** Revive native sync scalar values before shape validation or ORM encoding. */
export function reviveWireValues(
  contract: SyncServerContract,
  model: string,
  data: Record<string, unknown>,
  keyField?: string
): Record<string, unknown> {
  const fields = domainModelsAtDefaultNamespace(contract.domain)[model]?.fields;
  if (!fields) return data;
  return Object.fromEntries(
    Object.entries(data).map(([name, value]) => {
      const field = fields[name];
      const codecId = field?.type.kind === "scalar" ? nativeJsonCodecs[field.type.codecId] : undefined;
      const codec = codecId ? idbCodecLookup.get(codecId) : undefined;
      if (!codec) return [name, value];
      const revive = (input: unknown): unknown => {
        if (typeof input !== "string") return input;
        try {
          return codec.decodeJson(input);
        } catch {
          throw new PushPayloadValidationError(
            name === keyField ? "KEYPATH_VALIDATION_FAILURE" : "RECORD_VALIDATION_FAILURE",
            "Unable to decode sync field"
          );
        }
      };
      if (field?.many && Array.isArray(value)) return [name, value.map(revive)];
      return [name, revive(value)];
    })
  );
}

// Prisma 8 rc.12 short-circuits bare null parameters to SQL NULL before
// calling the JSON codec. Its pg/json and pg/jsonb codecs use JSON.stringify,
// so this write-only value reaches the codec and encodes to the text "null".
const jsonNull = Object.freeze({ toJSON: () => null });

function ormWriteValues(
  contract: SyncServerContract,
  model: string,
  data: Record<string, unknown>
): Record<string, unknown> {
  const fields = domainModelsAtDefaultNamespace(contract.domain)[model]?.fields;
  return Object.fromEntries(
    Object.entries(data).map(([name, value]) => {
      const field = fields?.[name];
      const requiredJson =
        field &&
        !field.nullable &&
        !field.many &&
        !field.dict &&
        field.type.kind === "scalar" &&
        ["pg/json@1", "pg/jsonb@1"].includes(field.type.codecId);
      return [name, value === null && requiredJson ? jsonNull : value];
    })
  );
}

/** Extracts the shape `sync-server`'s `validatePush` reads `payload[keyField]` from, per operation kind. */
export function toSyncPushPayload(operation: string, payload: unknown, keyField: string): Record<string, unknown> {
  // The wire schema accepts any JSON here, so a null / primitive / array
  // payload must fail this one event rather than throw out of the batch.
  if (operation !== "create" && operation !== "update" && operation !== "delete") {
    throw new Error(`Unsupported operation "${operation}"`);
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new PushPayloadValidationError(
      "RECORD_VALIDATION_FAILURE",
      `Invalid ${operation} payload: expected an object`
    );
  }
  if (operation === "create") return payload as Record<string, unknown>;
  if (operation === "update") {
    const { key, patch } = payload as { key?: unknown; patch?: unknown };
    if (key === undefined) {
      throw new PushPayloadValidationError(
        "KEYPATH_VALIDATION_FAILURE",
        `Unsupported update: filter does not pin "${keyField}" by equality`
      );
    }
    // Without an object patch, applyPushEvent would fall through to its delete branch.
    if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
      throw new PushPayloadValidationError(
        "RECORD_VALIDATION_FAILURE",
        "Invalid update payload: expected an object patch"
      );
    }
    if (keyField in patch && !Object.is((patch as Record<string, unknown>)[keyField], key)) {
      throw new PushPayloadValidationError("KEYPATH_VALIDATION_FAILURE", "Updates cannot change the primary key");
    }
    return { ...(patch as Record<string, unknown>), [keyField]: key };
  }
  return { [keyField]: (payload as { key: unknown }).key };
}

interface ChangelogIdQuery {
  where(clause: Record<string, unknown>): ChangelogIdQuery;
  select(...fields: string[]): ChangelogIdQuery;
  orderBy(fn: (row: { id: { desc(): unknown } }) => unknown): ChangelogIdQuery;
  limit(n: number): ChangelogIdQuery;
  all(): Promise<{ id: string }[]>;
}

/** The highest changelog id `scopeKey` has, or `null` for an empty scope (an index seek on `(scopeKey, id)`). */
async function maxChangelogId(tx: unknown, scopeKey: string): Promise<string | null> {
  const [latest] = await (ormRootFor(tx, "Changelog") as unknown as ChangelogIdQuery)
    .where({ scopeKey })
    .select("id")
    .orderBy((row) => row.id.desc())
    .limit(1)
    .all();
  return latest?.id ?? null;
}

/**
 * Authorizes, then applies, one outbox event: writes the model row + a
 * stamped `Changelog` row, atomically. Idempotent on the event's id.
 *
 * Authorization runs *inside* the same transaction as the write, right
 * before it — not before the transaction opens — so the row(s) it reads
 * (the record itself, and every hop the ownership walk crosses) are locked
 * against concurrent reassignment for the rest of the transaction.
 *
 * `db` must expose `.transaction(fn)`, calling `fn` with a scope whose
 * `.orm.public` works the same way `db.orm.public` does — the same
 * per-app-generated shape `ormRootFor` already treats as opaque.
 */
export async function applyPushEvent(
  db: unknown,
  contract: SyncServerContract,
  getKeyField: GetKeyField,
  event: SqlPushEvent,
  model: string,
  check: PushCheck,
  scopeKey: string
): Promise<SqlPushResult> {
  if (check.kind === "validation-failure") {
    return { id: event.id, success: false, error: check.error, retryable: false };
  }
  if (check.kind === "unknown-model") {
    return { id: event.id, success: false, error: "Unknown model", retryable: false };
  }

  try {
    return await (db as { transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> }).transaction(async (tx) => {
      const changelogRoot = ormRootFor(tx, "Changelog");
      const alreadyApplied = await changelogRoot.first({ outboxEventId: event.id });
      if (alreadyApplied) return { id: event.id, success: true };

      const keyField = getKeyField(contract, model);
      const nativeKey = reviveWireValues(contract, model, { [keyField]: check.key }, keyField)[keyField];
      const startRow: Record<string, unknown> | null =
        event.operation === "create"
          ? reviveWireValues(contract, model, event.payload as Record<string, unknown>)
          : await ormRootFor(tx, model).first({ [keyField]: nativeKey });

      if (!(await checkAuthorization(tx, contract, getKeyField, model, check, startRow))) {
        return { id: event.id, success: false, error: "SCOPE_VIOLATION", retryable: false };
      }

      // For updates, also re-check ownership against the row *as the patch
      // would leave it* — a patch that reassigns a parent FK (e.g. moves a
      // Todo to a Board the caller doesn't own) is authorized by the
      // pre-patch startRow check above but must not be allowed to land the
      // record in a scope the caller doesn't own.
      const patch =
        event.operation === "update"
          ? reviveWireValues(contract, model, (event.payload as { patch: Record<string, unknown> }).patch)
          : undefined;
      if (patch) {
        const proposedRow = { ...(startRow as Record<string, unknown>), ...patch };
        if (!(await checkAuthorization(tx, contract, getKeyField, model, check, proposedRow))) {
          return { id: event.id, success: false, error: "SCOPE_VIOLATION", retryable: false };
        }
      }

      const root = ormRootFor(tx, model);
      if (event.operation === "create") {
        await root.select(keyField).create(ormWriteValues(contract, model, startRow!));
      } else if (event.operation === "update" && patch) {
        await root
          .select(keyField)
          .where({ [keyField]: nativeKey })
          .update(ormWriteValues(contract, model, patch));
      } else if (event.operation === "delete") {
        await root.where({ [keyField]: nativeKey }).delete();
      } else {
        throw new Error(`Unsupported operation "${event.operation}"`);
      }

      // The lock is what makes commit order match the order ids are drawn in;
      // drawing each id above the scope's current max (read under the lock,
      // so it includes every earlier push's committed row) makes that order
      // match id order too — whatever process or clock the push ran on.
      await lockScope(db, tx, contract.target, scopeKey);
      await changelogRoot.select("id").create({
        id: nextChangelogId(await maxChangelogId(tx, scopeKey), Date.now()),
        model,
        keyPath: check.key,
        operation: event.operation,
        scopeKey,
        outboxEventId: event.id,
      });

      return { id: event.id, success: true };
    });
  } catch (err) {
    // Log the real error server-side only — it can carry DB-internal detail
    // (constraint names, SQL fragments) that shouldn't reach the client.
    console.error(`push apply failed for event ${event.id}`, err);
    return {
      id: event.id,
      success: false,
      error: `Failed to apply event ${event.id}`,
      retryable: true,
    };
  }
}
