import { UNBOUND_DOMAIN_NAMESPACE_ID, asNamespaceId } from "@prisma/orm-framework/contract/types";
import type { Contract } from "@prisma/orm-framework/contract/types";
import { describeMigrationStatement } from "@prisma/orm-framework/components/control";
import type {
  MigrationDataLoss,
  MigrationPlannerFailureResult,
  MigrationSubject,
  ResolvedMigrationStatement,
} from "@prisma/orm-framework/components/control";
import type { IdbDdlOp } from "./migration-factories";
import type { IdbSchemaDiffInput } from "./schema-diff";

const UNBOUND_NAMESPACE = asNamespaceId(UNBOUND_DOMAIN_NAMESPACE_ID);

/** How to keep rows the planner is about to drop, in the words the CLI prints after the question. */
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
    if (!Object.hasOwn(record.fields, field)) continue;
    losses.push({
      operationIndex,
      subject: fieldSubject(field),
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
 * The CLI asks the user about each entry before it writes or applies the
 * plan, so an operation left out here is applied without asking.
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

/**
 * Refuses the statements the user gave, or returns `undefined` when there are none.
 *
 * The planner cannot carry out a rename, convert or backfill itself. Ignoring
 * one would plan a drop and create, which loses the rows the statement was
 * given to keep, so the first statement is refused instead.
 */
export function refuseStatements(
  statements: readonly ResolvedMigrationStatement[],
  fromContract: Contract | null,
  contract: Contract
): MigrationPlannerFailureResult | undefined {
  const [statement] = statements;
  if (statement === undefined) return undefined;
  const summary =
    fromContract === null
      ? `The IDB planner cannot carry out the ${statement.kind} statement.`
      : `The IDB planner cannot carry out: ${describeMigrationStatement(statement, fromContract, contract)}`;
  return {
    kind: "failure",
    conflicts: [
      {
        kind: "statementRefused",
        summary,
        why:
          "Author the change in migration.ts with transformRecordsOp (renameFields, fields) " +
          "so existing rows keep their data, then plan again.",
        refusedStatement: statement,
      },
    ],
  };
}
