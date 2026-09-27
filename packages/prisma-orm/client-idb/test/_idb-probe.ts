/**
 * Test-only IndexedDB access probe.
 *
 * Wraps the read methods of `IDBObjectStore` and `IDBIndex` on the global
 * prototypes, so it sees every read from every code path: ORM queries, the
 * relation loader, and mutation-scope lookups that never touch the query
 * executor.
 *
 * It records what IndexedDB was asked to do, not how long it took:
 *
 * - `valuesRead`: record values handed back to JavaScript. Each one costs a
 *   structured-clone deserialization in a real browser. Cursor steps, `get`
 *   hits and `getAll` results all count.
 * - `keysRead`: primary keys returned by key-only reads (`getKey`,
 *   `getAllKeys`, `openKeyCursor`). No value is deserialized.
 * - `requests`: one entry per read request, with the store, the index (if
 *   any) and whether a key or key range was passed. `get` and
 *   `getKey` always pass one.
 *
 * These numbers are deterministic, so tests can assert them exactly.
 */

export type ProbeOp = "openCursor" | "openKeyCursor" | "get" | "getAll" | "getKey" | "getAllKeys" | "count";

export interface ProbeRequest {
  readonly op: ProbeOp;
  readonly store: string;
  readonly index: string | undefined;
  readonly ranged: boolean;
}

export interface ProbeSnapshot {
  readonly valuesRead: number;
  readonly keysRead: number;
  readonly requests: readonly ProbeRequest[];
}

export interface IdbProbe {
  snapshot(): ProbeSnapshot;
  reset(): void;
  uninstall(): void;
}

type Source = IDBObjectStore | IDBIndex;

const PROBED_OPS: readonly ProbeOp[] = [
  "openCursor",
  "openKeyCursor",
  "get",
  "getAll",
  "getKey",
  "getAllKeys",
  "count",
];

function describeSource(source: Source): { store: string; index: string | undefined } {
  return "objectStore" in source
    ? { store: source.objectStore.name, index: source.name }
    : { store: source.name, index: undefined };
}

/** Installs the probe on the current global `IDBObjectStore`/`IDBIndex` prototypes. */
export function installIdbProbe(): IdbProbe {
  let valuesRead = 0;
  let keysRead = 0;
  let requests: ProbeRequest[] = [];

  const restores: Array<() => void> = [];

  for (const proto of [globalThis.IDBObjectStore.prototype, globalThis.IDBIndex.prototype]) {
    for (const op of PROBED_OPS) {
      const original = (proto as unknown as Record<string, (...args: unknown[]) => IDBRequest>)[op];
      if (typeof original !== "function") continue;

      const wrapped = function (this: Source, ...args: unknown[]): IDBRequest {
        const req = original.apply(this, args);
        requests.push({ op, ...describeSource(this), ranged: args[0] !== undefined && args[0] !== null });
        req.addEventListener("success", () => {
          const result: unknown = req.result;
          switch (op) {
            case "openCursor":
              if (result !== null) valuesRead++;
              break;
            case "openKeyCursor":
              if (result !== null) keysRead++;
              break;
            case "get":
              if (result !== undefined) valuesRead++;
              break;
            case "getAll":
              valuesRead += (result as unknown[]).length;
              break;
            case "getKey":
              if (result !== undefined) keysRead++;
              break;
            case "getAllKeys":
              keysRead += (result as unknown[]).length;
              break;
            case "count":
              break;
          }
        });
        return req;
      };

      Object.defineProperty(proto, op, { value: wrapped, configurable: true, writable: true });
      restores.push(() => Object.defineProperty(proto, op, { value: original, configurable: true, writable: true }));
    }
  }

  return {
    snapshot: () => ({ valuesRead, keysRead, requests: [...requests] }),
    reset: () => {
      valuesRead = 0;
      keysRead = 0;
      requests = [];
    },
    uninstall: () => {
      for (const restore of restores) restore();
    },
  };
}

/**
 * Summarizes requests as sorted `op store[.index][ range]` strings, with a
 * `xN` suffix for repeats. Stable across runs, so it works in exact-match
 * assertions.
 */
export function summarizeRequests(requests: readonly ProbeRequest[]): string[] {
  const counts = new Map<string, number>();
  for (const r of requests) {
    const label = `${r.op} ${r.store}${r.index !== undefined ? `.${r.index}` : ""}${r.ranged ? " range" : ""}`;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([l, n]) => (n > 1 ? `${l} x${n}` : l));
}
