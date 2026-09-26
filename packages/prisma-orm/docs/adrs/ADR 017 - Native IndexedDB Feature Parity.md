# ADR 017: Native IndexedDB features

- **Status:** Accepted
- **Date:** 2026-09-25
- **Area:** Driver, ORM

## Summary

An audit of the IndexedDB API against what these packages actually use found four gaps. This ADR records what we now use and what we deliberately left out:

- **Compound keys and indexes.** Stores and indexes can be keyed on several fields.
- **Native `count()`.** Used only when it gives exactly the same answer as counting rows.
- **Key-only reads.** Used for checks that only ask whether a row exists.
- **Clear errors for inactive transactions.** A request on an already-finished transaction now gets its own error code.

## Decision

### 1. Compound primary keys and indexes

`@@id([a, b])`, `@@unique([a, b])` and `@@index([a, b])` now map to IndexedDB's array key paths: `createObjectStore(name, { keyPath: [...] })` and `createIndex(name, [...])`. An earlier version of the schema interpreter rejected compound keys, saying IndexedDB doesn't support them. That was wrong, and the rejection is gone.

- **Key paths.** A key path is `IdbKeyPath = string | readonly string[]`. Field order matters: `["a", "b"]` and `["b", "a"]` are different keys.
- **Building and comparing keys.** Keys are built from a row with `extractKeyFromRow`. They are compared with `keyEquals` and turned into `Map`/`Set` keys with `keyToken`. Both handle `Date`, binary and array keys by value, and `keyEquals` uses `indexedDB.cmp` when it's available.
- **No silent fallback.** `getKeyPath` throws when a model has no `storage.keyPath`. It used to fall back to `"id"`, which hid broken contracts.
- **Compound is not `multiEntry`.** A compound index combines several fields into one key. A `multiEntry` index turns one array field into several entries. They are separate features, and IndexedDB rejects combining them.
- **No single-field acceleration.** Compound and `multiEntry` indexes aren't used to speed up single-field equality filters. One `eq` condition can't pin a whole compound key. Using them well is a job for a future query planner.

### 2. Native `count()`, only when entries equal rows

`count()` and a count-only `aggregate()` use IndexedDB's own `store.count(range)` or `index.count(range)` through a new `IdbCountPlan`. They do so only when the result is guaranteed to match counting the rows:

- **No in-memory filter.** The whole `where` must be expressed as a key range.
- **No OR query.** Counting each branch separately would count a row twice if it matched two branches.
- **No `multiEntry` or compound index.** One record can have several entries in a `multiEntry` index.

`skip` and `take` are applied to the native total arithmetically (`clampCount`), which gives the same result. Everything else still reads and counts the rows.

The driver returns the count as a single row, `[{ count }]`, so its result shape stays the same ([ADR 006](ADR%20006%20-%20Collect%20then%20Yield%20Full%20Row%20Materialization.md)).

### 3. Key-only reads where only existence matters

A new `IdbKeysPlan` reads primary keys without loading records. It uses `getKey(range)` when `take` is 1, and `getAllKeys(range, take)` otherwise. It returns `[{ key }]`, or `[]` when nothing matches.

It is used only for "does a row with this primary key exist?":

- foreign-key checks on every write, including compound keys that reference a compound primary key,
- `setDefault`'s check that the default value's parent exists,
- `restrict` on a 1:1 relation where the child's primary key is also its foreign key.

Lookups that need the row's values, such as `cascade`, `setNull` and references to non-key fields, still scan records.

The key-only path compares by IndexedDB key equality. This fixed a false "FK violation" for parents keyed by a `DateTime`, where two equal `Date` objects are never `===`. The joins that later follow those foreign keys, in referential actions and `include()`, now compare the same way ([ADR 009](ADR%20009%20-%20FK%20Validation%20and%20Referential%20Action%20Enforcement.md)).

Nothing uses `getAllKeys` yet.

### 4. Clear errors when a transaction is no longer active

Letting IndexedDB commit transactions automatically is still the right design ([ADR 005](ADR%20005%20-%20Event-Driven%20Execution%20No%20Async%20Await.md)). But when code breaks the rule, the error used to be a bare `DOMException`. Now:

- **A dedicated error code.** A `TransactionInactiveError` or `InvalidStateError` thrown when issuing a request or calling `objectStore()` becomes an `IdbExecuteError` with the code `TRANSACTION_INACTIVE`, and a message explaining the auto-commit rule. This applies in single operations, batches and `IdbTransactionScope.execute`.
- **No more misleading `STORE_NOT_FOUND`.** Calling `objectStore()` on a finished transaction used to be reported that way.
- **No hang on an unknown plan kind.** The driver's dispatcher has a `default` case, so an unknown plan kind, for example from an outdated driver build, fails with an error instead of never completing.
- **Real-browser tests.** `apps/prisma-orm-usage/tests/fkEnforcement/cascade-transaction-lifetime.spec.ts` runs in Chromium and WebKit. It covers a three-level cascade, a wide fan-out, rollback after a chain of deletes across stores, and the `TRANSACTION_INACTIVE` error. The rollback test uses hand-built delete plans, because the demo contract has no operation that fails part-way through a cascade.

### Deliberately left out

| Feature                                                          | Why                                                                                                |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `cursor.continuePrimaryKey` (keyset pagination)                  | Nothing needs it yet. Worth revisiting if benchmarks show `skip`-heavy pagination is slow.         |
| `IDBTransaction.durability`                                      | No evidence that commit latency matters. Needs benchmarks first.                                   |
| `indexedDB.databases()`, `navigator.storage`                     | These are environment APIs, not part of querying.                                                  |
| Explicit `transaction.commit()`                                  | Automatic commit is safe (section 4), so an explicit commit would change nothing.                  |
| Range and compound-index acceleration, cost-based OR             | Needs a query planner.                                                                             |
| Consumers of `getAllKeys`, key-only reads for non-key references | These need a way to route a lookup through the right index, which the query planner would provide. |

## Consequences

- **More schemas can target IndexedDB.** Any schema with multi-field `@@id`, `@@unique` or `@@index` now works, including the MyFit app's.
- **Adding a plan kind touches five places:**
  - `plan-body.ts`,
  - `execute/ops.ts`,
  - a new error code,
  - the exhaustive switch in `sync-extension-idb`'s `sync-executor.ts`,
  - the driver's runtime type exports.
- **`client-idb` tests use the built driver.** `client-idb` imports `driver-idb` from its `dist` folder, so rebuild the driver before running them.
- **Native count is only tested in `fake-indexeddb`.** We haven't yet checked it against real browsers.

## Related

- [ADR 005](ADR%20005%20-%20Event-Driven%20Execution%20No%20Async%20Await.md): no `await` inside transactions.
- [ADR 006](ADR%20006%20-%20Collect%20then%20Yield%20Full%20Row%20Materialization.md): the driver's result shape.
- [ADR 007](ADR%20007%20-%20Two%20Transaction%20APIs.md): the manual transaction API.
- [ADR 009](ADR%20009%20-%20FK%20Validation%20and%20Referential%20Action%20Enforcement.md): foreign-key checks and referential actions.
