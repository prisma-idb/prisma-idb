import type { testDb } from "./helpers";

type Db = Awaited<ReturnType<typeof testDb>>;

/**
 * The real client, except that the first read of a Todo
 * runs `between` on another connection before it returns: a write that commits
 * after the pull read the row and before it checks the row's owner.
 */
export function interleaved(db: Db, between: () => Promise<void>): Db {
  let fired = false;
  const wrapReads = (scope: object) =>
    new Proxy(scope, {
      get(target, prop, receiver) {
        if (prop !== "orm") return Reflect.get(target, prop, receiver);
        const orm = Reflect.get(target, prop, receiver) as { public: Record<string, unknown> };
        const publicRoots = new Proxy(orm.public, {
          get(roots, model) {
            const root = Reflect.get(roots, model) as { first(where: unknown): Promise<unknown> };
            if (model !== "Todo") return root;
            return new Proxy(root, {
              get(r, method) {
                if (method !== "first") return Reflect.get(r, method);
                return async (where: unknown) => {
                  const row = await r.first(where);
                  if (!fired) {
                    fired = true;
                    await between();
                  }
                  return row;
                };
              },
            });
          },
        });
        return { ...orm, public: publicRoots };
      },
    });
  return new Proxy(wrapReads(db) as Db, {
    get(target, prop, receiver) {
      if (prop !== "transaction") return Reflect.get(target, prop, receiver);
      return (fn: (tx: unknown) => Promise<unknown>, options?: unknown) =>
        (db.transaction as (f: (tx: object) => Promise<unknown>, o?: unknown) => Promise<unknown>)(
          (tx) => fn(wrapReads(tx)),
          options
        );
    },
  });
}
