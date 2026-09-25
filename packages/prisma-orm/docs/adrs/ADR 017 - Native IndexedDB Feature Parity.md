# ADR 017 — Native IndexedDB Feature Parity

## Context

Phase 9 audited the IndexedDB Web API against what the IDB family actually emits and calls (`plans/PLAN_9.0_idb_web_api_feature_parity.md`). The audit found four real gaps and one hardening need; this ADR records what was decided, what was deliberately deferred, and why. Sub-plans: `PLAN_9.3_native_count.md`, `PLAN_9.4_key_only_reads.md`.

## Decision

### 1. Compound primary keys and compound indexes are supported natively (9.1, 9.2)

`@@id([a, b])`, `@@unique([a, b])` and `@@index([a, b])` map to array `keyPath`s (`createObjectStore(name, { keyPath: [...] })` / `createIndex(name, [...])`). The earlier rejection ("IDB does not support compound primary keys") was wrong and is removed.

- `IdbKeyPath = string | readonly string[]`. Key construction goes through `extractKeyFromRow`; key comparison and dedup go through `keyEquals`/`keyToken` (Date/binary/nested-array aware, using `indexedDB.cmp` when available).
- `getKeyPath` throws when a model has no `storage.keyPath` — the old silent `"id"` fallback was removed (it hid contract errors).
- **Compound ≠ `multiEntry`.** A compound index composes several fields into one key; `multiEntry` explodes one array field into many entries. Orthogonal.
- Compound/`multiEntry` indexes are excluded from the single-field equality-hint map (`buildFieldToIndexMap`). A lone `eq` cannot pin a compound key; accelerating them is a planner decision (Phase 10).

### 2. Native `count()` is used only when entries == rows (9.3)

`IdbCountPlan` (`store.count(range)` / `index.count(range)`) backs the ORM `.count()` terminal and count-only `aggregate()`, **only** when there is no in-memory filter and the path can't double-count (no OR union, no `multiEntry`/compound index). `skip`/`take` are applied arithmetically to the native total (`clampCount`). Everything else stays a materialized scan. Result rows are synthetic (`[{ count }]`) so the driver keeps ADR 006's collect-then-yield contract.

### 3. Key-only reads are used where only existence matters (9.4)

`IdbKeysPlan` (`getKey(range)` for `take: 1`, else `getAllKeys(range, take)`; rows `[{ key }]`/`[]`). Wired only to lookups that are "does a row whose own single-field primary key equals V exist": FK validation (create/update), the `setDefault` default-exists check, and `restrict` on a shared-PK 1:1. Lookups that consume row values (cascade, `setNull`, upsert, non-PK targets) stay `cursor-scan`. Side effect: the key-only path compares by IDB key equality, fixing a false "FK violation" for `DateTime`-keyed parents (`===` on two equal `Date`s). `getAllKeys` has no consumer yet (Phase 10.5).

### 4. Dead-transaction failures are diagnosable (9.5)

The implicit-auto-commit design (ADR 005) is sound but its failure mode was a bare `DOMException`. Now:

- `TransactionInactiveError`/`InvalidStateError` thrown by request issuance or `objectStore()` become `IdbExecuteError` with code `TRANSACTION_INACTIVE` and a message pointing at ADR 005/007 (`executeOpInTx`, `IdbTransactionScope.execute`, batch runner). Previously `objectStore()` on a finished transaction was misreported as `STORE_NOT_FOUND`.
- `executeOpInTx` has a `default` case, so an unknown plan kind (e.g. a stale driver build) errors instead of hanging.
- Real-browser Playwright coverage (Chromium + WebKit, `apps/prisma-orm-usage/tests/fkEnforcement/cascade-transaction-lifetime.spec.ts`): 3-level cascade, wide fanout, rollback after a multi-store delete chain, and `TRANSACTION_INACTIVE` surfacing. The rollback test uses raw delete plans shaped like a cascade because the demo contract has no operation that fails mid-cascade.

### Deliberately deferred

| Feature                                                   | Why deferred                                                                                                                                 |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `cursor.continuePrimaryKey` (keyset pagination)           | No call site needs it; revisit if Phase 10 benchmarks show `skip`-heavy pagination is costly.                                                |
| `IDBTransaction.durability`                               | No evidence commit latency matters; needs Tier 2 benchmark evidence first.                                                                   |
| `indexedDB.databases()`, `navigator.storage.*`            | Host/environment APIs, not query surface.                                                                                                    |
| Explicit `transaction.commit()`                           | Implicit commit verified safe (§4); explicit commit changes nothing.                                                                         |
| Range-operator/compound-index acceleration, cost-based OR | Planner work — Phase 10.                                                                                                                     |
| `getAllKeys` consumers, non-PK key-only FK lookups        | Need Phase 10.5's index routing.                                                                                                             |
| `db.transaction()` JSDoc warning                          | The ergonomic API isn't wired to the public client yet; it must carry the "only await IDB-request-resolving promises" warning when it ships. |

## Consequences

- Any Prisma schema with `@@id`/`@@unique`/`@@index` over several fields can target IDB (unblocks the MyFit schema).
- Plan-kind additions have a fixed ripple: `plan-body.ts`, `execute/ops.ts`, an error code, `sync-executor.ts`'s exhaustive switch, and the driver's runtime type export. `client-idb` resolves `driver-idb` from `dist`, so rebuild it before running client tests.
- Native count has a real-browser parity risk that is only covered by fake-indexeddb unit tests today.

## Related

ADR 005 (no async inside transactions), ADR 006 (collect-then-yield), ADR 007 (two transaction APIs), ADR 009 (referential actions).
