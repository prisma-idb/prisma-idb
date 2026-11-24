import { UNBOUND_DOMAIN_NAMESPACE_ID, asNamespaceId } from "@prisma/orm-framework/contract/types";
import type { MigrationDataLoss, MigrationSubject } from "@prisma/orm-framework/components/control";
import type { IdbDdlOp } from "./migration-factories";
import type { IdbSchemaDiffInput } from "./schema-diff";

const UNBOUND_NAMESPACE = asNamespaceId(UNBOUND_DOMAIN_NAMESPACE_ID);

/** Advice for preserving rows the planner is about to drop. */
const KEEP_DATA_ADVICE =
  "Author the change in migration.ts with transformRecordsOp so the rows are rewritten instead of dropped.";

/**
 * Names the model a store holds, or the store itself when the origin schema
 * carries no record metadata for it (a legacy DDL-only contract).
 */
function storeSubject(from: IdbSchemaDiffInput | null, storeName: string): MigrationSubject {
  const model = from?.stores[storeName]?.record?.model;
  return model === undefined
    ? { kind: "storage", name: storeName }
    : { kind: "model", namespaceId: UNBOUND_NAMESPACE, model };
}

/** Lists the data a store-record transform removes, one entry per dropped or retyped field. */
function recordTransformLosses(
  operationIndex: number,
  op: IdbDdlOp,
  from: IdbSchemaDiffInput | null
): MigrationDataLoss[] {
  if (op.kind !== "transformRecords") return [];
  const record = from?.stores[op.storeName]?.record;
  if (record === undefined) return [];
  const losses: MigrationDataLoss[] = [];
  const fieldSubject = (field: string): MigrationSubject => ({
    kind: "field",
    namespaceId: UNBOUND_NAMESPACE,
    model: record.model,
    field,
  });
  for (const field of op.removeFields ?? []) {
    losses.push({
      operationIndex,
      subject: fieldSubject(field),
      loss: "drop",
      label: op.label,
      keepDataAdvice: KEEP_DATA_ADVICE,
    });
  }
  // A transform on a field that already held values re-types it; a field new to the record loses nothing.
  for (const field of Object.keys(op.fields ?? {})) {
    // A renamed field's values come from its old name, so a transform under the new name re-types them.
    const source =
      op.renameFields !== undefined && Object.hasOwn(op.renameFields, field) ? op.renameFields[field]! : field;
    if (!Object.hasOwn(record.fields, source)) continue;
    losses.push({
      operationIndex,
      subject: fieldSubject(source),
      loss: "typeChange",
      label: op.label,
      keepDataAdvice: KEEP_DATA_ADVICE,
    });
  }
  return losses;
}

/**
 * Lists every operation of a plan that can lose rows or values, in plan order.
 *
 * Callers can use these entries to explain potential data loss. The
 * `migration plan` command does not prompt on them; it keeps its existing
 * warning after writing the package.
 */
export function dataLossOf(ops: readonly IdbDdlOp[], from: IdbSchemaDiffInput | null): MigrationDataLoss[] {
  return ops.flatMap((op, operationIndex) => {
    if (op.kind === "dropObjectStore") {
      return [
        {
          operationIndex,
          subject: storeSubject(from, op.storeName),
          loss: "drop" as const,
          label: op.label,
          keepDataAdvice: KEEP_DATA_ADVICE,
        },
      ];
    }
    return recordTransformLosses(operationIndex, op, from);
  });
}
