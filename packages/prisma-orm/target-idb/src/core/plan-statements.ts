import type { MigrationPlannerConflict, ResolvedMigrationStatement } from "@prisma/orm-framework/components/control";
import type { IdbRecordField, IdbRecordShape, IdbStoreDefinition } from "./idb-contract-types";
import { keyPathFields } from "./idb-contract-types";
import type { IdbSchemaDiffInput } from "./schema-diff";

/** What the statements ask of one store's existing rows. */
export interface StoreStatementPlan {
  /** `{ newName: oldName }` for each renamed field. */
  readonly renameFields: Record<string, string>;
  readonly renamedFrom: Set<string>;
  /** Fields whose values the author fills in by hand: backfills, conversions, and renames to an incompatible type. */
  readonly authored: Set<string>;
  /** The positions, in the statements list, of the statements this store carries out. */
  readonly statementIndexes: number[];
}

/** The planned statements, by store name. */
export type StatementPlan = Map<string, StoreStatementPlan>;

/** The store that holds `model` in `schema`, or `undefined` when no store does. */
function storeOfModel(
  schema: IdbSchemaDiffInput | null,
  model: string
): { readonly name: string; readonly store: IdbStoreDefinition & { readonly record: IdbRecordShape } } | undefined {
  for (const [name, store] of Object.entries(schema?.stores ?? {})) {
    if (store.record?.model === model) return { name, store: store as IdbStoreDefinition & { record: IdbRecordShape } };
  }
  return undefined;
}

/** `true` when `field` is, or is the root of, part of the store's primary key. */
function isKeyField(store: IdbStoreDefinition, field: string): boolean {
  return keyPathFields(store.keyPath).some((key) => key === field || key.startsWith(`${field}.`));
}

/** A conflict that refuses `statement` for `why`. */
function refused(statement: ResolvedMigrationStatement, summary: string, why: string): MigrationPlannerConflict {
  return { kind: "statementRefused", summary, why, refusedStatement: statement };
}

/**
 * Turns the user's rename, backfill and convert statements into per-store
 * instructions for the record diff, or the conflicts that refuse them.
 *
 * A field rename moves the stored value to the new name. A backfill or a conversion leaves a
 * placeholder the author fills in `migration.ts`, as upstream leaves the code
 * to the user. Statements about namespaces, enum values and value objects
 * have no IndexedDB form and are refused.
 */
export function planStatements(
  statements: readonly ResolvedMigrationStatement[],
  from: IdbSchemaDiffInput | null,
  to: IdbSchemaDiffInput,
  hasStoredDefault: (storeName: string, fieldName: string, field: IdbRecordField) => boolean
):
  | { readonly ok: true; readonly plan: StatementPlan }
  | { readonly ok: false; readonly conflicts: MigrationPlannerConflict[] } {
  const plan: StatementPlan = new Map();
  const conflicts: MigrationPlannerConflict[] = [];
  const entryFor = (storeName: string): StoreStatementPlan => {
    let entry = plan.get(storeName);
    if (entry === undefined) {
      entry = {
        renameFields: Object.create(null) as Record<string, string>,
        renamedFrom: new Set(),
        authored: new Set(),
        statementIndexes: [],
      };
      plan.set(storeName, entry);
    }
    return entry;
  };

  // Statements use destination names. Collect renames first so flag order does not affect lookup.
  const originalField = new Map<string, string>();
  for (const statement of statements) {
    if (statement.kind !== "rename") continue;
    if (statement.entity === "field") {
      originalField.set(JSON.stringify([statement.to.model, statement.to.field]), statement.from.field);
    }
  }

  statements.forEach((statement, index) => {
    if (statement.kind === "rename" && statement.entity === "field") {
      const before = storeOfModel(from, statement.from.model);
      const after = storeOfModel(to, statement.to.model);
      const fromField = statement.from.field;
      const toField = statement.to.field;
      const label = `${statement.from.model}.${fromField} to ${statement.to.model}.${toField}`;
      if (before === undefined || after === undefined || before.name !== after.name) {
        conflicts.push(
          refused(
            statement,
            `Cannot rename field ${label}: both models must be stored in the same store.`,
            "Name each model as its contract declares it. IndexedDB cannot move a field between stores."
          )
        );
        return;
      }
      if (isKeyField(before.store, fromField) || isKeyField(after.store, toField)) {
        conflicts.push(
          refused(
            statement,
            `Cannot rename field ${label}: it is part of the primary key.`,
            "IndexedDB cannot change a store's key path. Author a migration that creates a new store and copies the rows."
          )
        );
        return;
      }
      const missing = !Object.hasOwn(before.store.record.fields, fromField)
        ? `the origin model has no field "${fromField}"`
        : !Object.hasOwn(after.store.record.fields, toField)
          ? `the destination model has no field "${toField}"`
          : Object.hasOwn(after.store.record.fields, fromField)
            ? `the destination model still has a field "${fromField}"`
            : Object.hasOwn(before.store.record.fields, toField)
              ? `the origin model already has a field "${toField}"`
              : undefined;
      if (missing !== undefined) {
        conflicts.push(
          refused(
            statement,
            `Cannot rename field ${label}: ${missing}.`,
            "Rename a field that only the origin contract declares to one that only the destination declares."
          )
        );
        return;
      }
      const entry = entryFor(after.name);
      const repeated = entry.renamedFrom.has(fromField)
        ? "the origin field already appears in a rename"
        : Object.hasOwn(entry.renameFields, toField)
          ? "the destination field already appears in a rename"
          : undefined;
      if (repeated !== undefined) {
        conflicts.push(
          refused(
            statement,
            `Cannot rename field ${label}: ${repeated}.`,
            "Use each field once on each side of a rename."
          )
        );
        return;
      }
      entry.renameFields[toField] = fromField;
      entry.renamedFrom.add(fromField);
      entry.statementIndexes.push(index);
      return;
    }

    if ((statement.kind === "backfill" || statement.kind === "convert") && statement.entity === "field") {
      const after = storeOfModel(to, statement.field.model);
      const field = statement.field.field;
      const label = `${statement.field.model}.${field}`;
      const originModel = statement.field.model;
      const before = storeOfModel(from, originModel);
      const originField = originalField.get(JSON.stringify([statement.field.model, field])) ?? field;
      const originLabel = `${originModel}.${originField}`;
      if (after === undefined || !Object.hasOwn(after.store.record.fields, field)) {
        conflicts.push(
          refused(
            statement,
            `Cannot ${statement.kind} ${label}: the destination contract has no field ${label}.`,
            "Name a stored field of the destination contract."
          )
        );
        return;
      }
      if (before === undefined || before.name !== after.name) {
        const detail =
          before === undefined
            ? `the origin contract has no store for model "${originModel}"`
            : `the model moves from store "${before.name}" to "${after.name}"`;
        conflicts.push(
          refused(
            statement,
            `Cannot ${statement.kind} ${label}: ${detail}.`,
            "The model must keep the same existing store to transform its records."
          )
        );
        return;
      }
      const problem =
        statement.kind === "convert" && !Object.hasOwn(before.store.record.fields, originField)
          ? `the origin contract has no field ${originLabel} to convert`
          : isKeyField(after.store, field)
            ? `${label} is part of the primary key, which IndexedDB cannot rewrite`
            : undefined;
      if (problem !== undefined) {
        conflicts.push(
          refused(
            statement,
            `Cannot ${statement.kind} ${label}: ${problem}.`,
            "Name a non-key field of the destination contract."
          )
        );
        return;
      }
      if (
        statement.kind === "backfill" &&
        !Object.hasOwn(before.store.record.fields, originField) &&
        hasStoredDefault(after.name, field, after.store.record.fields[field]!)
      ) {
        conflicts.push(
          refused(
            statement,
            `Cannot backfill ${label}: the field is new and has a supported literal default.`,
            "The default fills the existing rows when the field is added. Leave out the --backfill statement."
          )
        );
        return;
      }
      const entry = entryFor(after.name);
      entry.authored.add(field);
      entry.statementIndexes.push(index);
      return;
    }

    if (statement.kind === "rename" && statement.entity === "model") {
      conflicts.push(
        refused(statement, "The IDB planner cannot carry out a model rename.", "Only field renames are supported.")
      );
      return;
    }

    conflicts.push(
      refused(
        statement,
        `The IDB planner cannot carry out a ${statement.kind} statement for ${statement.entity === "namespace" ? "a namespace" : statement.entity === "enumValue" ? "an enum value" : statement.entity === "valueObjectField" ? "a value object field" : `a ${statement.entity}`}.`,
        "IndexedDB has no storage form for it. Author the change in migration.ts with transformRecordsOp, then plan again."
      )
    );
  });

  return conflicts.length > 0 ? { ok: false, conflicts } : { ok: true, plan };
}
