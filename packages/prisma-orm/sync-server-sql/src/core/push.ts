import type { GetKeyField, OwnershipCheck, SyncServerContract } from "@prisma-idb/sync-server";
import { ormRootFor } from "./orm-root";
import { checkAuthorization } from "./authorization";

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

/** Extracts the shape `sync-server`'s `validatePush` reads `payload[keyField]` from, per operation kind. */
export function toSyncPushPayload(operation: string, payload: unknown, keyField: string): Record<string, unknown> {
  if (operation === "create") return payload as Record<string, unknown>;
  if (operation === "update") {
    const { key } = payload as { key?: unknown };
    if (key === undefined) {
      throw new Error(`Unsupported update: filter does not pin "${keyField}" by equality`);
    }
    return { [keyField]: key };
  }
  if (operation === "delete") return { [keyField]: (payload as { key: unknown }).key };
  throw new Error(`Unsupported operation "${operation}"`);
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
  check: OwnershipCheck,
  scopeKey: string
): Promise<SqlPushResult> {
  if (check.kind === "unknown-model") {
    return { id: event.id, success: false, error: "Unknown model", retryable: false };
  }

  try {
    return await (db as { transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> }).transaction(async (tx) => {
      const changelogRoot = ormRootFor(tx, "Changelog");
      const alreadyApplied = await changelogRoot.first({ outboxEventId: event.id });
      if (alreadyApplied) return { id: event.id, success: true };

      const keyField = getKeyField(contract, model);
      const startRow: Record<string, unknown> | null =
        event.operation === "create"
          ? (event.payload as Record<string, unknown>)
          : await ormRootFor(tx, model).first({ [keyField]: check.key });

      if (!(await checkAuthorization(tx, contract, getKeyField, model, check, startRow))) {
        return { id: event.id, success: false, error: "SCOPE_VIOLATION", retryable: false };
      }

      // For updates, also re-check ownership against the row *as the patch
      // would leave it* — a patch that reassigns a parent FK (e.g. moves a
      // Todo to a Board the caller doesn't own) is authorized by the
      // pre-patch startRow check above but must not be allowed to land the
      // record in a scope the caller doesn't own.
      const patch =
        event.operation === "update" ? (event.payload as { patch: Record<string, unknown> }).patch : undefined;
      if (patch) {
        const proposedRow = { ...(startRow as Record<string, unknown>), ...patch };
        if (!(await checkAuthorization(tx, contract, getKeyField, model, check, proposedRow))) {
          return { id: event.id, success: false, error: "SCOPE_VIOLATION", retryable: false };
        }
      }

      const root = ormRootFor(tx, model);
      if (event.operation === "create") {
        await root.select(keyField).create(event.payload as Record<string, unknown>);
      } else if (event.operation === "update" && patch) {
        // `check.key` (resolved by the caller via `toSyncPushPayload`, same
        // value) is what identifies the row — not `event.payload`, which
        // still carries the client's raw outbox record (`{ patch, key }`)
        // rather than the ORM's `.where()` matcher shape.
        await root
          .select(keyField)
          .where({ [keyField]: check.key })
          .update(patch);
      } else {
        await root.where({ [keyField]: (event.payload as { key: unknown }).key }).delete();
      }

      await changelogRoot.select("id").create({
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
