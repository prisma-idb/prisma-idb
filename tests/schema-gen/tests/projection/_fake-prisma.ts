import { getDMMF } from "@prisma/internals";

/** A model as the DMMF describes it. */
type DmmfModel = Awaited<ReturnType<typeof getDMMF>>["datamodel"]["models"][number];

/** One stored record. */
type Row = Record<string, unknown>;
/** The subset of a Prisma `where` that the generated processor sends. */
type Where = Record<string, unknown>;
/** A Prisma `select` that nests only through to-one relations. */
type Select = Record<string, true | { select: Select }>;

/** A to-one relation: the related model and the scalar foreign-key field that points at it. */
interface Relation {
  readonly model: string;
  readonly foreignKey: string;
}

/** To-one relations of every model, keyed by model name and then by relation field name. */
type RelationMap = Map<string, Map<string, Relation>>;

/** The fake's mutable state. `tables` is replaced as a whole when a transaction rolls back. */
interface Store {
  tables: Map<string, Row[]>;
  nextChangelogId: number;
}

/** An in-memory stand-in for the Prisma Client that the generated batch processor calls. */
export interface FakePrisma {
  /** Pass this as `prisma` to the generated `applyPush` and `pullAndMaterializeLogs`. */
  readonly prisma: unknown;
  /** The rows currently stored for a model. */
  rows(model: string): Row[];
}

/**
 * Builds an in-memory Prisma Client for the given schema, so the generated server code runs
 * without a database. The database is the one boundary the generated code talks to, so it is the
 * one thing faked.
 *
 * Relations come from the schema's real DMMF. The fake understands only what the generated
 * processor sends: equality, `OR`, `gt`, to-one relation filters, nested `select`, and the
 * `findUnique`, `findFirst`, `findMany`, `create`, `upsert` and `deleteMany` operations. A
 * `$transaction` that throws rolls back, like the real one. Other Prisma features, such as
 * to-many relation filters, `orderBy` and unique constraints, are deliberately not modeled.
 */
export async function createFakePrisma(schemaSource: string, seed: Record<string, Row[]> = {}): Promise<FakePrisma> {
  const { datamodel } = await getDMMF({ datamodel: schemaSource });
  const relations = readToOneRelations(datamodel.models);
  const store: Store = {
    tables: new Map(datamodel.models.map((m) => [m.name, (seed[m.name] ?? []).map((row) => ({ ...row }))])),
    nextChangelogId: 1,
  };

  const prisma: Record<string, unknown> = Object.fromEntries(
    datamodel.models.map((m) => [
      m.name.charAt(0).toLowerCase() + m.name.slice(1),
      createDelegate(m.name, store, relations),
    ])
  );
  prisma.$transaction = async (work: (tx: unknown) => Promise<unknown>) => {
    const before = new Map([...store.tables].map(([name, rows]) => [name, rows.map((row) => ({ ...row }))]));
    try {
      return await work(prisma);
    } catch (error) {
      store.tables = before;
      throw error;
    }
  };

  return { prisma, rows: (model) => store.tables.get(model)!.map((row) => ({ ...row })) };
}

/** Collects each model's to-one relations (those with a local foreign-key field) from the DMMF. */
function readToOneRelations(models: readonly DmmfModel[]): RelationMap {
  const relations: RelationMap = new Map();
  for (const model of models) {
    const toOne = new Map<string, Relation>();
    for (const field of model.fields) {
      const [foreignKey] = field.relationFromFields ?? [];
      if (field.kind === "object" && foreignKey) toOne.set(field.name, { model: field.type, foreignKey });
    }
    relations.set(model.name, toOne);
  }
  return relations;
}

/** Follows a to-one relation from `row`, or returns `null` when the foreign key is unset or dangling. */
function related(
  store: Store,
  relations: RelationMap,
  model: string,
  row: Row,
  field: string
): { model: string; row: Row } | null {
  const relation = relations.get(model)?.get(field);
  const key = relation && row[relation.foreignKey];
  const found = relation && key != null ? store.tables.get(relation.model)!.find((r) => r.id === key) : undefined;
  return relation && found ? { model: relation.model, row: found } : null;
}

/**
 * Evaluates a `where` against a row. A relation filter is true only when the related row exists
 * and matches, as in Prisma. `gt` compares strings, which is all the pull cursor needs.
 */
function matches(store: Store, relations: RelationMap, model: string, row: Row, where: Where): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === "OR") return (condition as Where[]).some((branch) => matches(store, relations, model, row, branch));
    if (relations.get(model)?.has(key)) {
      const target = related(store, relations, model, row, key);
      return target !== null && matches(store, relations, target.model, target.row, condition as Where);
    }
    if (condition !== null && typeof condition === "object" && "gt" in condition) {
      const { gt } = condition as { gt?: string };
      return gt === undefined || (row[key] as string) > gt;
    }
    return row[key] === condition;
  });
}

/** Applies a nested `select`. A missing to-one relation projects to `null`, like Prisma. */
function project(store: Store, relations: RelationMap, model: string, row: Row, select: Select): Row {
  return Object.fromEntries(
    Object.entries(select).map(([field, spec]) => {
      if (spec === true) return [field, row[field]];
      const target = related(store, relations, model, row, field);
      return [field, target ? project(store, relations, target.model, target.row, spec.select) : null];
    })
  );
}

/** Builds the model delegate (`prisma.ticket`, ...) over the store. `Changelog` rows get generated ids. */
function createDelegate(model: string, store: Store, relations: RelationMap) {
  const rowsOf = () => store.tables.get(model)!;
  const find = async ({ where, select }: { where: Where; select?: Select }) => {
    const row = rowsOf().find((r) => matches(store, relations, model, r, where));
    if (!row) return null;
    return select ? project(store, relations, model, row, select) : { ...row };
  };
  return {
    findUnique: async (args: { where: Where; select?: Select }) => {
      // Like the real client, a unique lookup cannot be asked for a null key.
      if (Object.values(args.where).some((value) => value == null)) {
        throw new Error(`Invalid findUnique() invocation: ${JSON.stringify(args.where)} must not be null.`);
      }
      return find(args);
    },
    findFirst: find,
    findMany: async ({ where, take }: { where: Where; take?: number }) =>
      rowsOf()
        .filter((r) => matches(store, relations, model, r, where))
        .sort((a, b) => String(a.id).localeCompare(String(b.id)))
        .slice(0, take),
    create: async ({ data }: { data: Row }) => {
      const row = model === "Changelog" ? { id: `changelog-${store.nextChangelogId++}`, ...data } : { ...data };
      rowsOf().push(row);
      return { ...row };
    },
    upsert: async ({ where, create, update }: { where: Where; create: Row; update: Row }) => {
      const existing = rowsOf().find((r) => matches(store, relations, model, r, where));
      if (existing) Object.assign(existing, update);
      else rowsOf().push({ ...create });
    },
    deleteMany: async ({ where }: { where: Where }) => {
      store.tables.set(
        model,
        rowsOf().filter((r) => !matches(store, relations, model, r, where))
      );
    },
  };
}

/** Builds the outbox event the client sends for one record change. */
export function outboxEvent(entityType: string, operation: "create" | "update" | "delete", payload: Row) {
  return {
    id: `event-${entityType}-${operation}-${String(payload.id)}`,
    entityType,
    operation,
    payload,
    createdAt: new Date(0),
    tries: 0,
    lastError: null,
    synced: false,
    syncedAt: null,
    retryable: true,
    lastAttemptedAt: null,
  };
}
