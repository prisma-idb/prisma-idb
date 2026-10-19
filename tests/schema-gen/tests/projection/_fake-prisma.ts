import { getDMMF } from "@prisma/internals";

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;
type Select = Record<string, true | { select: Select }>;

/** A to-one relation: the related model and the scalar foreign-key field that points at it. */
interface Relation {
  readonly model: string;
  readonly foreignKey: string;
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
 * `$transaction` that throws rolls back, like the real one.
 */
export async function createFakePrisma(schemaSource: string, seed: Record<string, Row[]> = {}): Promise<FakePrisma> {
  const { datamodel } = await getDMMF({ datamodel: schemaSource });
  const relations = new Map<string, Map<string, Relation>>();
  for (const model of datamodel.models) {
    const toOne = new Map<string, Relation>();
    for (const field of model.fields) {
      const [foreignKey] = field.relationFromFields ?? [];
      if (field.kind === "object" && foreignKey) toOne.set(field.name, { model: field.type, foreignKey });
    }
    relations.set(model.name, toOne);
  }

  let tables = new Map(datamodel.models.map((m) => [m.name, (seed[m.name] ?? []).map((row) => ({ ...row }))]));
  let nextChangelogId = 1;

  const related = (model: string, row: Row, field: string): { model: string; row: Row } | null => {
    const relation = relations.get(model)?.get(field);
    const key = relation && row[relation.foreignKey];
    const found = relation && key != null ? tables.get(relation.model)!.find((r) => r.id === key) : undefined;
    return relation && found ? { model: relation.model, row: found } : null;
  };

  const matches = (model: string, row: Row, where: Where): boolean =>
    Object.entries(where).every(([key, condition]) => {
      if (key === "OR") return (condition as Where[]).some((branch) => matches(model, row, branch));
      if (relations.get(model)?.has(key)) {
        const target = related(model, row, key);
        return target !== null && matches(target.model, target.row, condition as Where);
      }
      if (condition !== null && typeof condition === "object" && "gt" in condition) {
        const { gt } = condition as { gt?: string };
        return gt === undefined || (row[key] as string) > gt;
      }
      return row[key] === condition;
    });

  const project = (model: string, row: Row, select: Select): Row =>
    Object.fromEntries(
      Object.entries(select).map(([field, spec]) => {
        if (spec === true) return [field, row[field]];
        const target = related(model, row, field);
        return [field, target ? project(target.model, target.row, spec.select) : null];
      })
    );

  const delegate = (model: string) => {
    const find = async ({ where, select }: { where: Where; select?: Select }) => {
      const row = tables.get(model)!.find((r) => matches(model, r, where));
      if (!row) return null;
      return select ? project(model, row, select) : { ...row };
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
        tables
          .get(model)!
          .filter((r) => matches(model, r, where))
          .sort((a, b) => String(a.id).localeCompare(String(b.id)))
          .slice(0, take),
      create: async ({ data }: { data: Row }) => {
        const row = model === "Changelog" ? { id: `changelog-${nextChangelogId++}`, ...data } : { ...data };
        tables.get(model)!.push(row);
        return { ...row };
      },
      upsert: async ({ where, create, update }: { where: Where; create: Row; update: Row }) => {
        const existing = tables.get(model)!.find((r) => matches(model, r, where));
        if (existing) Object.assign(existing, update);
        else tables.get(model)!.push({ ...create });
      },
      deleteMany: async ({ where }: { where: Where }) => {
        tables.set(
          model,
          tables.get(model)!.filter((r) => !matches(model, r, where))
        );
      },
    };
  };

  const prisma: Record<string, unknown> = Object.fromEntries(
    datamodel.models.map((m) => [m.name.charAt(0).toLowerCase() + m.name.slice(1), delegate(m.name)])
  );
  prisma.$transaction = async (work: (tx: unknown) => Promise<unknown>) => {
    const before = new Map([...tables].map(([name, rows]) => [name, rows.map((row) => ({ ...row }))]));
    try {
      return await work(prisma);
    } catch (error) {
      tables = before;
      throw error;
    }
  };

  return { prisma, rows: (model) => tables.get(model)!.map((row) => ({ ...row })) };
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
