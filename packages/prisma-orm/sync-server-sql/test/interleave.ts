import type { testDb } from "./helpers";

type Db = Awaited<ReturnType<typeof testDb>>;

/** Commits a write after the selected pull read returns from PostgreSQL. */
export function interleaved(db: Db, between: () => Promise<void>, after: "todo" | "changelog" = "todo"): Db {
  let fired = false;
  const afterRead = async (result: Promise<unknown>) => {
    const row = await result;
    if (!fired) {
      fired = true;
      await between();
    }
    return row;
  };
  const wrapChangelog = (query: object): object =>
    new Proxy(query, {
      get(target, method, receiver) {
        const value = Reflect.get(target, method, receiver) as unknown;
        if (typeof value !== "function") return value;
        if (method === "all") return () => afterRead(value.call(target) as Promise<unknown>);
        return (...args: unknown[]) => wrapChangelog(value.apply(target, args) as object);
      },
    });
  const wrapReads = (scope: object) =>
    new Proxy(scope, {
      get(target, prop, receiver) {
        if (prop !== "orm") return Reflect.get(target, prop, receiver);
        const orm = Reflect.get(target, prop, receiver) as { public: Record<string, unknown> };
        const publicRoots = new Proxy(orm.public, {
          get(roots, model) {
            const root = Reflect.get(roots, model) as { first(where: unknown): Promise<unknown> };
            if (after === "changelog" && model === "Changelog") return wrapChangelog(root);
            if (after !== "todo" || model !== "Todo") return root;
            return new Proxy(root, {
              get(r, method) {
                if (method !== "first") return Reflect.get(r, method);
                return (where: unknown) => afterRead(r.first(where));
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
