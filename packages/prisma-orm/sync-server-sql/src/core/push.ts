import { domainModelsAtDefaultNamespace } from "@prisma/orm-framework/contract/types";
import type { GetKeyField, PushCheck, SyncPushEvent, SyncServerContract } from "@prisma-idb/sync-server";
import { ormRootFor } from "./orm-root";
import { checkAuthorization } from "./authorization";
import { appendChangelogRow, isEventApplied } from "./changelog";
import { reviveWireValues, WireValidationError } from "./wire-values";

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
    throw new WireValidationError("RECORD_VALIDATION_FAILURE", `Invalid ${operation} payload: expected an object`);
  }
  if (operation === "create") return payload as Record<string, unknown>;
  if (operation === "update") {
    const { key, patch } = payload as { key?: unknown; patch?: unknown };
    if (key === undefined) {
      throw new WireValidationError(
        "KEYPATH_VALIDATION_FAILURE",
        `Unsupported update: filter does not pin "${keyField}" by equality`
      );
    }
    // Without an object patch, applyPushEvent would fall through to its delete branch.
    if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
      throw new WireValidationError("RECORD_VALIDATION_FAILURE", "Invalid update payload: expected an object patch");
    }
    if (keyField in patch && !Object.is((patch as Record<string, unknown>)[keyField], key)) {
      throw new WireValidationError("KEYPATH_VALIDATION_FAILURE", "Updates cannot change the primary key");
    }
    return { ...(patch as Record<string, unknown>), [keyField]: key };
  }
  return { [keyField]: (payload as { key: unknown }).key };
}

/**
 * Decodes one wire event into the `SyncPushEvent` shape `validatePush` takes:
 * the wire form, plus its payload revived to native values. Revival happens
 * only here, so each event is decoded once however it reaches the adapter.
 *
 * A model the contract can't resolve a key for gets an empty payload:
 * `validatePush` reports it as an unknown model, so it fails as an ordinary
 * non-retryable event result.
 * @throws {WireValidationError | Error} If the event's payload can't be shaped or decoded.
 */
export function decodeWireEvent(
  contract: SyncServerContract,
  getKeyField: GetKeyField,
  model: string,
  event: SqlPushEvent
): SyncPushEvent {
  let keyField: string | undefined;
  try {
    keyField = getKeyField(contract, model);
  } catch {
    keyField = undefined;
  }
  const wirePayload = keyField === undefined ? {} : toSyncPushPayload(event.operation, event.payload, keyField);
  return {
    id: event.id,
    model,
    operation: event.operation,
    wirePayload,
    payload: reviveWireValues(contract, model, wirePayload, keyField),
  };
}

/** The non-retryable result for an event that could not be decoded. */
export function decodeFailureResult(id: string, err: unknown): SqlPushResult {
  return {
    id,
    success: false,
    error: err instanceof WireValidationError ? err.code : err instanceof Error ? err.message : "Unsupported event",
    retryable: false,
  };
}

/** A check that already failed: there is nothing to authorize, so nothing is written. */
type RejectedCheck = Extract<PushCheck, { kind: "validation-failure" | "unknown-model" }>;

function isRejected(check: PushCheck): check is RejectedCheck {
  return check.kind === "validation-failure" || check.kind === "unknown-model";
}

/** The non-retryable result for an event whose `validatePush` check failed. */
function rejectedResult(id: string, check: RejectedCheck): SqlPushResult {
  const error = check.kind === "validation-failure" ? check.error : "Unknown model";
  return { id, success: false, error, retryable: false };
}

/**
 * Decodes, then applies, one wire event. The adapter's public form of
 * `applyPushEventDecoded`, for callers that hold the wire event and the
 * `validatePush` check for it.
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
  if (isRejected(check)) return rejectedResult(event.id, check);
  let decoded: SyncPushEvent;
  try {
    decoded = decodeWireEvent(contract, getKeyField, model, event);
  } catch (err) {
    return decodeFailureResult(event.id, err);
  }
  return applyPushEventDecoded(db, contract, getKeyField, decoded, check, scopeKey);
}

/**
 * Authorizes, then applies, one decoded outbox event: writes the model row +
 * a stamped `Changelog` row, atomically. Idempotent on the event's id.
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
export async function applyPushEventDecoded(
  db: unknown,
  contract: SyncServerContract,
  getKeyField: GetKeyField,
  event: SyncPushEvent,
  check: PushCheck,
  scopeKey: string
): Promise<SqlPushResult> {
  if (isRejected(check)) return rejectedResult(event.id, check);
  const { model } = event;

  try {
    return await (db as { transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> }).transaction(async (tx) => {
      if (await isEventApplied(tx, event.id)) return { id: event.id, success: true };

      // The decoded payload carries the key; for an update, everything else is the patch.
      const keyField = getKeyField(contract, model);
      const { [keyField]: nativeKey, ...patch } = event.payload;
      const startRow: Record<string, unknown> | null =
        event.operation === "create" ? event.payload : await ormRootFor(tx, model).first({ [keyField]: nativeKey });

      const isAuthorized = (row: Record<string, unknown> | null) =>
        checkAuthorization(tx, contract, getKeyField, model, check, row);
      const scopeViolation: SqlPushResult = {
        id: event.id,
        success: false,
        error: "SCOPE_VIOLATION",
        retryable: false,
      };

      if (!(await isAuthorized(startRow))) return scopeViolation;

      // For updates, also re-check ownership against the row *as the patch
      // would leave it* — a patch that reassigns a parent FK (e.g. moves a
      // Todo to a Board the caller doesn't own) is authorized by the
      // pre-patch startRow check above but must not be allowed to land the
      // record in a scope the caller doesn't own.
      if (
        event.operation === "update" &&
        !(await isAuthorized({ ...(startRow as Record<string, unknown>), ...patch }))
      ) {
        return scopeViolation;
      }

      const root = ormRootFor(tx, model);
      if (event.operation === "create") {
        await root.select(keyField).create(ormWriteValues(contract, model, event.payload));
      } else if (event.operation === "update") {
        await root
          .select(keyField)
          .where({ [keyField]: nativeKey })
          .update(ormWriteValues(contract, model, patch));
      } else if (event.operation === "delete") {
        await root.where({ [keyField]: nativeKey }).delete();
      } else {
        throw new Error(`Unsupported operation "${event.operation}"`);
      }

      await appendChangelogRow(db, tx, contract, scopeKey, {
        model,
        keyPath: check.key,
        operation: event.operation,
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
