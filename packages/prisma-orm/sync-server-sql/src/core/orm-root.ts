/**
 * Minimal shape of a Prisma 8 SQL ORM model root — the handful of
 * operations this package needs, common to every generated model
 * regardless of which one it is. The real generated client is far richer
 * per model; this is deliberately narrow so a runtime, string-keyed model
 * lookup (`ormRootFor`) has a concrete shape to cast into.
 */
export interface OrmRoot {
  first(where: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  select(...fields: string[]): {
    create(data: Record<string, unknown>): Promise<unknown>;
    where(clause: Record<string, unknown>): {
      update(patch: Record<string, unknown>): Promise<unknown>;
    };
  };
  where(clause: Record<string, unknown>): {
    delete(): Promise<unknown>;
  };
}

/**
 * `db` is an opaque, per-app generated ORM client — its exact type is
 * unique to whatever schema the app compiled, so this package can't
 * reference it directly. `db.orm.public[model]` is the one dynamic lookup
 * every Prisma 8 SQL client supports the same way; the cast below is
 * real, not a type-system workaround — a runtime string model name
 * genuinely can't be checked against a client whose exact shape is only
 * known per app.
 */
export function ormRootFor(db: unknown, model: string): OrmRoot {
  const root = (db as { orm: { public: Record<string, OrmRoot> } }).orm.public[model];
  if (!root) throw new Error(`Model "${model}" not found on db.orm.public.`);
  return root;
}
