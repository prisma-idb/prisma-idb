# Prisma 8 IDB — Package Architecture

This document covers the full mental model for the six packages in `packages/prisma-orm/`: what each one is, why it exists, what every entrypoint contains, and how they connect to each other.

---

## The Big Idea: Two Planes

Prisma 8 separates all code into two execution planes. Understanding this split is the foundation for everything else.

| Plane             | Also called      | Runs where              | Purpose                                      |
| ----------------- | ---------------- | ----------------------- | -------------------------------------------- |
| **Control plane** | build-time / CLI | Node.js (never browser) | Schema migration, introspection, CLI tooling |
| **Runtime plane** | execution plane  | Browser (or Node.js)    | Actual query execution against the database  |

Every package in this family respects this split. Code that does DDL (creating object stores, running migrations) is **control plane only** — it must never land in a browser bundle. Code that executes a `findMany` is **runtime plane**.

---

## The Six Layers

A Prisma 8 database family is composed of six layers. Each layer has a specific responsibility and a specific location in the call stack.

```
User's app code
        │
        ▼
   [ client-idb ]      ← typed ORM surface (idbOrm)
        │
        ▼
   [ runtime-idb ]     ← wires adapter + driver into RuntimeCore
        │
        ▼
   [ adapter-idb ]     ← translates query plan → IDB operation body
        │
        ▼
   [ driver-idb ]      ← executes the plan against indexedDB
        │
        ▼
   [ target-idb ]      ← identity + codecs + migration system
        │
        ▼
   window.indexedDB
        │
        ▲
   [ family-idb ]      ← control plane only; CLI integration
```

### Analogy: a restaurant kitchen

- **client-idb** — the waiter/menu. Takes the customer's order in typed, familiar terms (`db.users.create({…})`) and hands a structured ticket to the kitchen.
- **runtime-idb** — the expeditor. Coordinates the prep cook and line cook, verifies the recipe version matches, runs quality checks (middleware).
- **adapter-idb** — the prep cook. Takes an order ticket and turns it into specific actions ("slice onions, brown beef") using the recipe book.
- **driver-idb** — the line cook. Executes those specific actions against the actual stove (IndexedDB API). Doesn't know or care about recipes.
- **target-idb** — the recipe book + kitchen rulebook. Defines what the food is, how ingredients map to dishes (codecs), and how to upgrade the kitchen equipment (migrations).
- **family-idb** — the restaurant manager. Knows the whole operation, talks to suppliers (CLI), knows the menu contract. Never cooks.

---

## Package Reference

### `@prisma-idb/target-idb`

**What it is:** The IDB family's identity declaration + migration system.

**Analogies:** recipe book, passport, rulebook.

**Entrypoints:**

| Entrypoint     | Plane               | What it contains                                                                                                                                                                                                                                                                                                                                                                                    | Who imports it                                                                        |
| -------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `.` / `./pack` | neither (pure data) | `{ kind: 'target', familyId: 'idb', targetId: 'idb', version, capabilities }` as a typed const                                                                                                                                                                                                                                                                                                      | adapter `/pack`, family-idb, anyone needing the identity object                       |
| `./control`    | control only        | Default export `IdbControlTargetDescriptor`. Carries `migrations: { createPlanner, createRunner, contractToSchema }` so the framework's CLI can plan and (in non-IDB families) apply migrations. The IDB runner's `executeAcrossSpaces` returns a refusal envelope (see `family-idb`).                                                                                                              | CLI, family-idb                                                                       |
| `./runtime`    | runtime only        | `RuntimeTargetDescriptor` with `codecs()` + `create()` factory and `idbCodecLookup` for the adapter                                                                                                                                                                                                                                                                                                 | Execution stack at query time                                                         |
| `./migration`  | control only        | Public API for authoring migration files: `Migration` base class (`IdbMigration` re-exported as `Migration`), `MigrationCLI.run` self-emit shim, DDL op factories (`createObjectStoreOp`, `createIndexOp`, `dropObjectStoreOp`, `dropIndexOp`), and the shared `openAndUpgrade` / `applyOneDdlOp` / `readMarker` / `writeMarker` apply helpers used by both browser auto-migrate and CLI preflight. | User-authored `migration.ts` files; `client-idb/auto-migrate`; `family-idb/preflight` |

**Why `/pack` and `/control` are separate:**
`/control` contains the migration runner and schema diffing. If these were bundled with `/pack`, every browser bundle importing the target would carry the entire migration system. By keeping them separate, only Node.js/CLI code ever imports `/control`.

**Key type: `capabilities`**
The capabilities object declares what IDB can and cannot do. For example:

- `transactionalDDL: true` — IDB's `upgradeneeded` IS a version-change transaction
- `ddlOnlyInUpgrade: true` — DDL can ONLY happen inside `upgradeneeded` (custom IDB constraint)
- `returning: false` — IDB has no `RETURNING` clause
- `compoundKeys: false` — forbidden by sync ownership invariants

---

### `@prisma-idb/adapter-idb`

**What it is:** The translation layer between Prisma's query AST and IDB operation bodies.

**Analogy:** the prep cook's instruction sheet — translates "findMany where age > 18 orderBy name" into a concrete sequence of IDB cursor operations.

**Entrypoints:**

| Entrypoint  | Plane        | What it contains                                                                                                                                | Who imports it                |
| ----------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `./control` | control only | `ControlAdapterDescriptor` with `scalarTypeDescriptors` (Prisma type → IDB codec ID map), schema introspector, helpers for the migration runner | CLI, family-idb               |
| `./runtime` | runtime only | `RuntimeAdapterDescriptor` with a `lower(queryAST)` method that produces opaque plan bodies the driver can execute                              | Execution stack at query time |

**`scalarTypeDescriptors` explained:**
This is how the framework knows how to store each Prisma type. Example:

```ts
scalarTypeDescriptors: new Map([
  ["String", "idb/string@1"],
  ["Int", "idb/int32@1"],
  ["Float", "idb/double@1"],
  ["Boolean", "idb/bool@1"],
  ["DateTime", "idb/date@1"],
  ["BigInt", "idb/bigint@1"],
  ["Decimal", "idb/decimal@1"],
  ["Json", "idb/json@1"],
  ["Bytes", "idb/bytes@1"],
]);
```

**Depends on:** `target-idb` (needs the target's pack identity and codec type surface).

---

### `@prisma-idb/driver-idb`

**What it is:** The `window.indexedDB` execution wrapper — takes the adapter's opaque plan bodies and actually runs them against IDB.

**Analogy:** the line cook. Given a concrete ticket ("open cursor on 'users' store, filter where age > 18"), executes it. Does not know what query was originally asked.

**Entrypoints:**

| Entrypoint  | Plane        | What it contains                                                                                                      | Who imports it                |
| ----------- | ------------ | --------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `./control` | control only | `ControlDriverDescriptor` with a `create()` async factory that opens an IDB database connection for CLI/migration use | CLI                           |
| `./runtime` | runtime only | The actual `IDBDriverImpl` class + `createIDBDriver()` factory — executes plan bodies against `window.indexedDB`      | Execution stack at query time |

**Why the driver has `/control`:**
Even though IDB is browser-native, the CLI needs to open an IDB-like connection to run migrations (e.g. in a test environment, or via a server-side IDB polyfill). The `ControlDriverDescriptor` is the CLI's hook to do that. The `/control` entrypoint is also where the driver registers its version with the framework.

**Does NOT depend on `adapter-idb`.** The driver only knows about plan bodies (opaque objects the adapter produced). It does not need to understand how those bodies were created. The dependency direction is:

```
driver (no deps on adapter)
adapter → target
family → target
runtime-idb → adapter, driver
client-idb → target, adapter, driver
```

---

### `@prisma-idb/runtime-idb`

**What it is:** The `RuntimeCore` subclass for IndexedDB. Wires the adapter and driver together into a single `execute(plan)` method, verifies the contract marker, and runs the middleware lifecycle.

**Analogy:** the kitchen expeditor. Takes the waiter's ticket, coordinates the prep cook (adapter) and line cook (driver), verifies the recipe version hasn't changed, and enforces quality checks (middleware).

**Entrypoints:**

| Entrypoint  | Plane        | What it contains                                                                                                             | Who imports it       |
| ----------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `./runtime` | runtime only | `createIdbRuntime({ adapter, driver, contract })` factory + `IdbRuntime` interface + `IdbMiddleware` type + `verifyMarker()` | User app, client-idb |

**Key methods on `IdbRuntime`:**

| Method           | What it does                                                                              |
| ---------------- | ----------------------------------------------------------------------------------------- |
| `execute(plan)`  | Lowers the plan via the adapter, runs it via the driver, yields typed rows                |
| `verifyMarker()` | Compares the live `_prisma_next_marker` store's `storageHash` against the contract's hash |
| `close()`        | Closes the IDB database connection via the driver                                         |

**`verifyMarker()` explained:**
Before executing queries, the runtime reads the `_prisma_next_marker` object store (created by the migration runner) and compares the stored `storageHash` against `contract.storage.storageHash`. A match means the live schema matches what the contract expects. A mismatch means a migration is needed. A missing marker means the database was never initialised.

**Middleware:**
The runtime accepts an optional `middleware` array of `IdbMiddleware` objects. Each middleware has:

- `name: string` — required by the framework SPI for diagnostics and the cache key
- `familyId?: "idb"` — optional family discriminant; matches the vendor `MongoMiddleware`/`SqlMiddleware` pattern. Cross-family cache middleware omits this field
- `beforeExecute(plan, ctx)` — called before the driver runs
- `onRow(row, plan, ctx)` — called for every row yielded by the driver
- `afterExecute(plan, ctx)` — called after the driver finishes

**`RuntimeMiddlewareContext` construction (`buildMiddlewareContext()`):**
When the caller doesn't supply a `ctx`, the runtime builds one from the contract:

- `contract` — the contract object itself, available for middleware introspection (model layout, hashes)
- `mode: "permissive"` — non-strict semantics for parse/decode boundary
- `log` — no-op stubs (info/warn/error); user supplies their own via `ctx` override
- `now: Date.now` — wall-clock provider
- `scope: "runtime"` — fixed today; will switch to `"transaction"` when `withMutationScope()` lands (Phase 6.3)
- `contentHash(exec)` — canonicalizes the lowered plan, hashes via WebCrypto SHA-512. Functions (`IdbRowFilter`, `IdbRowComparator`) are skipped; `IDBKeyRange` is reduced to `{ lower, upper, lowerOpen, upperOpen }`. Output is stable across equivalent queries and suitable as a cross-family cache key.

Note: collect-then-yield (ADR 006) means `onRow` fires after all rows have already been materialized inside the IDB transaction. The hook runs as a sequence over the in-memory array, not as backpressure into the cursor — see Phase 6 review notes in `PLAN.md`.

**Depends on:** `adapter-idb` (for `lower()`), `driver-idb` (for `execute()`, `readMarker()`, `close()`).

---

### `@prisma-idb/client-idb`

**What it is:** The typed ORM surface — `idbOrm({ contract, executor })` returns a client where every model in the contract becomes a typed accessor with methods like `.create()`, `.all()`, `.where()`, `.first()`, `.delete()`. Also ships two higher-level entrypoints (`./client`, `./client-auto`) that assemble the whole runtime stack so user code doesn't need to wire driver/adapter/runtime by hand.

**Analogy:** the waiter and menu. The customer (app code) writes `db.users.create({ name: "Alice" })` — the client translates this into an `IdbQueryPlan` and hands it to the runtime executor.

**Entrypoints:**

| Entrypoint      | Plane        | What it contains                                                                                                                                                                                                                                                                      | Who imports it |
| --------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `./orm`         | runtime only | `idbOrm({ contract, executor })` factory + `IdbOrmClient` type + `IdbStoreAccessor` type. Bring-your-own runtime (you pass any `IdbQueryExecutor`).                                                                                                                                   | Advanced users |
| `./client`      | runtime only | `createIdbClient({ contract, dbName, middleware? })` — assembles `driver + adapter + runtime + orm` and returns `{ orm, verifyMarker, close, [asyncDispose] }`.                                                                                                                       | Most user apps |
| `./client-auto` | runtime only | `createAutoMigratingIdbClient({ contractSpace, dbName, policy? })` — same as `./client` but first walks `contractSpace.migrations` from the in-DB marker to `headRef.hash` and applies any pending packages. Policy defaults to safe (additive + widening only, destructive refused). | SPA / Path A   |

**Key types:**

| Type                    | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IdbOrmClient<T>`       | A mapped type over `contract.roots` — each root key becomes an `IdbStoreAccessor` property                                                                                                                                                                                                                                                                                                                                                               |
| `IdbStoreAccessor<T,M>` | Typed per-model accessor. Reads: `all()`, `where()`, `first()`, `findUnique()`, `count()`, `orderBy()`, `take()`, `skip()`, `include()`. Writes: `create()`, `createAll()`/`createCount()`, `update()`/`updateAll()`/`updateCount()`, `upsert()`, `delete()`/`deleteAll()`/`deleteCount()`. `create()`/`update()` accept relation-callback fields (`posts: (rel) => rel.create([...])`) → nested multi-store writes via `withMutationScope` (Phase 6.4). |
| `IdbQueryExecutor`      | A thin interface: `execute<Row>(plan: IdbQueryPlan<Row>): AsyncIterableResult<Row>`                                                                                                                                                                                                                                                                                                                                                                      |
| `WhereFilter<T,M>`      | Typed shorthand filter shape — `{ field: value }`, with `null` lifting to a null-check expression                                                                                                                                                                                                                                                                                                                                                        |
| `WhereCallback<T,M>`    | Callback form of `where()`: receives the typed `IdbModelAccessor` proxy and returns an `IdbFilterExpr`                                                                                                                                                                                                                                                                                                                                                   |
| `IdbModelAccessor<T,M>` | Proxy handed to `where(fn)` callbacks. Each field has `eq/neq/gt/lt/gte/lte/in/notIn/contains/startsWith/endsWith/isNull/isNotNull` operators                                                                                                                                                                                                                                                                                                            |
| `IdbFilterExpr`         | Discriminated union AST (`field` / `and` / `or` / `not` / `null-check`) backing every filter. Combine via `and(...)`, `or(...)`, `not(e)` exports                                                                                                                                                                                                                                                                                                        |

**How it works:**

1. `idbOrm()` reads `contract.roots` (e.g. `{ users: "User", posts: "Post" }`)
2. For each root, it instantiates an `IdbStoreAccessorImpl` targeting the model
3. When you call `db.users.create({ name: "Alice" })`, the accessor:
   - Generates a client-side `id` (uuid/cuid)
   - Builds an `IdbQueryPlan` with an `IdbPutPlan` body
   - Calls `executor.execute(plan)`
4. The executor is typically an `IdbRuntime` — which lowers the plan via the adapter and runs it via the driver

**`groupingKey` on plan meta:**
Every `IdbQueryPlan` emitted by the ORM carries a `groupingKey` in its `meta.annotations` — a unique string like `"idb-op-1"`, `"idb-op-2"`. This key propagates through sub-plans (e.g. relation loads) so middleware can correlate operations.

**Intermediate AST on plans:**
Each plan carries an optional `ast` field (`IdbQueryAst`) describing the query intent (`findMany`, `findUnique`, `create`, `delete`). This lets middleware inspect query structure without parsing opaque plan bodies.

**Depends on:** `target-idb` (for contract types), `adapter-idb` (for `IdbQueryPlan` shape), `driver-idb` (for `IdbPlanBody` types). Does NOT depend on `runtime-idb` — the executor interface is structural.

---

### `@prisma-idb/family-idb`

**What it is:** The control-plane integration point for the IDB family. This is what a `prisma.config.ts` or CLI flow imports. It is **never imported in browser code**.

**Analogy:** the restaurant manager. Knows the full family setup, assembles it for the CLI, validates contracts. Does not cook anything.

**Entrypoints:**

| Entrypoint         | Plane               | What it contains                                                                                                                                                                                                                                                                                                                                | Who imports it                |
| ------------------ | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `./control`        | control only        | Default export `IdbFamilyDescriptor` + type re-exports (`IdbContract`, `IdbSchemaIR`, `IdbStoreIR`, `IdbIndexIR`). Phase-7 family instance has no manifest driver — CLI methods return `IDB-CLI-UNSUPPORTED` envelopes; the active surface is `deserializeContract` (pure) and `verifySchema` (pure)                                            | `prisma.config.ts`, CLI       |
| `./pack`           | neither (pure data) | The family's pure pack ref — passed to `defineContract({ family, ... })` so the contract is bound to the IDB family identity                                                                                                                                                                                                                    | `contract.ts` authoring files |
| `./contract-ts`    | neither (pure data) | `defineContract(input)` — TypeScript-first authoring helper. Takes `{ family, target, models: { ModelName: { store, key, indexes?, relations? } } }`, derives the full `Contract<IdbStorage>` object with `storageHash` + `profileHash` computed (capabilities baked in to match `prisma contract emit`), validates it, returns. No PSL needed. | `contract.ts` authoring files |
| `./config-types`   | control only        | `defineConfig()` re-export for `prisma.config.ts`, plus `typescriptContract()` helper that ties a TS-authored contract to its emitted `contract.json` path                                                                                                                                                                                      | `prisma.config.ts`            |
| `./bin/prisma-idb` | control only        | IDB-specific CLI binary (`prisma-idb` on `PATH` once published). Subcommands: `generate-baseline`, `generate-contract-space`, `preflight`. See [§ Migration package layout](#migration-package-layout) below.                                                                                                                                   | Project-level npm scripts     |

**There is no `./runtime` entrypoint.** Runtime stack composition is done by `client-idb` via `createIdbClient()` (or `createAutoMigratingIdbClient()`).

**CLI surface, post-Phase 7 — refusal-only.** IndexedDB is a browser API; the CLI runs in Node.js with no live IDB to talk to. Every method on `IdbControlFamilyInstance` that would normally read or write a database returns a structured `IDB-CLI-UNSUPPORTED` envelope:

- `verify` / `sign` → `{ ok: false, code: 'IDB-CLI-UNSUPPORTED', summary: "IndexedDB cannot be { verified | signed } from the CLI…" }`
- `readMarker` / `readAllMarkers` → `null` / empty map (the framework's typing requires concrete `ContractMarkerRecord | null` here; the refusal is communicated via the sibling `verify` / `sign`)
- `introspect` → `{ stores: {} }` (same typing constraint; framework code that branches on this gets an "empty schema" answer)

The active CLI surface for an IDB project is therefore narrow:

- `prisma contract emit` — generates `contract.json` + `contract.d.ts` (pure)
- `prisma migration new` / `migration plan` — scaffolds a migration package (pure)
- `prisma-idb generate-baseline` — auto-creates the first migration from `contract.json` (pure file write)
- `prisma-idb migration contract-space` — bundles on-disk packages into `contract-space.generated.ts` (pure file write)
- `prisma-idb migration preflight` — walks the chain empty→tip against a fresh `fake-indexeddb` instance (the only legitimate use of `fake-indexeddb` in the toolchain)

**`prisma.config.ts` for an IDB project** still needs a `driver` value to satisfy the framework's config schema. Use the stub `idbControlDriverDescriptor` from `@prisma-idb/driver-idb/control` — it's a no-op whose `query()` / `close()` exist only to satisfy the type:

```ts
import idbFamily from "@prisma-idb/family-idb/control";
import idbTarget from "@prisma-idb/target-idb/control";
import idbAdapter from "@prisma-idb/adapter-idb/control";
import idbDriver from "@prisma-idb/driver-idb/control";

export default defineConfig({
  family: idbFamily,
  target: idbTarget,
  adapter: idbAdapter,
  driver: idbDriver,
  db: { connection: ":memory:" }, // ignored; IDB resolves the name in the browser
  contract: typescriptContract(contract, "src/lib/prisma/contract.json"),
  migrations: { dir: "migrations" },
});
```

### Migration package layout

Phase 7 adopted the framework's standard `migrations/<space>/` shape. The on-disk artefacts are the canonical authoring surface; the runtime consumes them through a bundled `ContractSpace`:

```
<app>/
├── migrations/
│   └── app/
│       └── 20260527T1635_baseline/
│           ├── migration.json      ← MigrationMetadata (from, to, migrationHash, hints, …)
│           ├── ops.json            ← canonical IdbDdlOp[] applied at upgrade time
│           ├── end-contract.json   ← contract snapshot after this migration
│           ├── end-contract.d.ts   ← .d.ts companion (used by next migration's start-contract)
│           └── migration.ts        ← class M extends Migration { … }; MigrationCLI.run(…)
└── src/lib/prisma/
    ├── contract.prisma             ← (optional) PSL source
    ├── contract.json               ← emitted by `prisma contract emit`
    ├── contract.d.ts               ← emitted alongside contract.json
    └── contract-space.generated.ts ← emitted by `prisma-idb migration contract-space`
```

`contract-space.generated.ts` JSON-imports each package's `migration.json` + `ops.json` and assembles them via `contractSpaceFromJson<Contract>` into the in-memory `ContractSpace<Contract>` value the browser-side `createAutoMigratingIdbClient` consumes. There is **no `migrations/refs/head.json`** for the app space — the head ref is inlined into the generated module (derived from the last package's `to`). Extensions that contribute migrations to IDB would each own their own space under `migrations/<extension-id>/` and write a `refs/head.json` per the framework's extension layout.

**There is no `prisma-idb.manifest.json`.** Phase 7 deleted the manifest entirely (see [FEEDBACK.md](FEEDBACK.md) §3 for rationale). The only authoritative position record is the in-DB marker row in `_prisma_next_marker`, keyed by `space` (`"app"` for the app contract space).

**Depends on:** `target-idb` only. The family descriptor needs the target's `/pack` metadata to expose `idbTargetDescriptor` to the CLI. It does not depend on the adapter or driver — those are the user's runtime concern.

---

## Entrypoint Flow Diagrams

### Authoring plane (developer evolves the contract)

```
developer edits src/lib/prisma/contract.server.ts (or contract.prisma)
  │
  ├── pnpm exec prisma contract emit
  │     └── @prisma/orm-toolchain ← writes contract.json + contract.d.ts
  │
  ├── pnpm exec prisma-idb migration plan
  │     └── family tooling writes migrations/app/<ts>_<slug>/{migration.json, ops.json,
  │         end-contract.json, end-contract.d.ts, migration.ts}
  │         migration.ts ends with `MigrationCLI.run(import.meta.url, M);`
  │
  ├── pnpm exec prisma-idb migration contract-space
  │     └── family-idb/bin ← writes src/lib/prisma/contract-space.generated.ts
  │         which JSON-imports each package's metadata + ops + inlines the head ref
  │
  └── pnpm exec prisma-idb migration preflight  (optional CI gate)
        └── family-idb/preflight ← walks the chain empty→tip against fake-indexeddb
```

The CLI never touches a live IndexedDB. Database application happens in the browser through `createAutoMigratingIdbClient`.

### Browser plane (user opens the app for the first time, or after a contract change)

```
User's app
  ├── import { createAutoMigratingIdbClient } from "@prisma-idb/client-idb/client-auto"
  └── import { contractSpace } from "./prisma/contract-space.generated"
        │
        └── createAutoMigratingIdbClient({ contractSpace, dbName: "my-app" })
              │
              ├── 1. open IDB at its current local version; read _prisma_next_marker[space="app"]
              ├── 2. if marker.storageHash === contractSpace.headRef.hash, fast-path return
              ├── 3. otherwise walkChain(marker → headRef.hash), collecting ops with policy filter
              │     │
              │     └── refuse if destructive ops dropped and policy.onDestructive === "refuse"
              │
              ├── 4. close, reopen at db.version + 1 → upgradeneeded fires
              │     └── target-idb/migration ← applyOneDdlOp(db, tx, op) for each pending op
              │
              ├── 5. write the new marker to _prisma_next_marker[space="app"] in a fresh tx
              │
              └── 6. hand back createIdbClient({ contract: contractSpace.contractJson, dbName })
```

### Runtime plane (user calls `db.orm.users.all()` or `db.orm.users.create({…})`)

```
User's app
  └── const client = await createAutoMigratingIdbClient({ contractSpace, dbName })
        │
        ├── client.orm = idbOrm({ contract, executor: runtime })
        │     ├── runtime = createIdbRuntime({ adapter, driver, contract })
        │     │     ├── adapter-idb/runtime ← lower(plan, { contract }) → IdbPlanBody
        │     │     └── driver-idb/runtime  ← execute(planBody) → async iterable rows
        │     └── runtime is structurally `IdbQueryExecutor`
        │
        ├── client.withTransaction(["users", "posts"], async (scope) => …)
        │     └── runtime.transaction(stores, "readwrite") → IdbTransactionScope
        │           └── scope.execute(plan) runs IdbAtomicPlans in the shared IDB tx,
        │               bypassing the middleware chain so cache reads stay fresh
        │
        └── client.orm.users.create({ name: "Alice" })
              └── builds IdbQueryPlan { idbPlan: IdbPutPlan, meta: { groupingKey: "idb-op-1" } }
              └── runtime.execute(plan)
                    ├── adapter.lower(plan, { contract }) → IdbPlanBody
                    ├── middleware.beforeExecute(planBody, ctx)
                    ├── driver.execute(planBody) → yield rows
                    │     └── middleware.onRow(row, planBody, ctx) per row
                    └── middleware.afterExecute(planBody, ctx)
```

---

## Dependency Graph

```
family-idb ──────────────────┐
                              │ (depends on)
target-idb ◄──────────────── adapter-idb ◄────── runtime-idb
     ▲                                              ▲
     └── family-idb                                 │
                                              client-idb
                                                    │
driver-idb ◄────────────────────────────────────────┘

client-idb depends on target-idb, adapter-idb, driver-idb
runtime-idb depends on adapter-idb, driver-idb
```

- `adapter-idb` → `target-idb` (needs target pack identity and codec types)
- `family-idb` → `target-idb` (needs pack metadata to build control descriptors)
- `driver-idb` → nothing in this family (only needs framework-components types)
- `runtime-idb` → `adapter-idb`, `driver-idb` (wires `lower()` + `execute()` + `readMarker()` into a `RuntimeCore`)
- `client-idb` → `target-idb`, `adapter-idb`, `driver-idb` (needs contract types, plan shapes, and plan body types)

---

## Key Terminology

| Term                         | Meaning                                                                                                                                                                                                                                                                                                                            |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Descriptor**               | A pure-data object that describes a layer (target/adapter/driver/family). Contains identity fields + factory methods. Never has mutable state.                                                                                                                                                                                     |
| **Instance**                 | A live object created from a descriptor's `create()` method. Has the actual connection, open cursors, etc.                                                                                                                                                                                                                         |
| **ControlFamilyDescriptor**  | The top-level descriptor for a family. The CLI calls `create(stack)` on it to get a family instance for migrations.                                                                                                                                                                                                                |
| **ControlDriverDescriptor**  | The driver's control-plane descriptor. Has `create(url)` to open a connection for CLI use.                                                                                                                                                                                                                                         |
| **ControlAdapterDescriptor** | The adapter's control-plane descriptor. Has `scalarTypeDescriptors` mapping Prisma types to storage codec IDs.                                                                                                                                                                                                                     |
| **RuntimeTargetDescriptor**  | Target's runtime descriptor. Has `codecs()` (codec registry) and `create()` (target instance factory). Used by the execution stack.                                                                                                                                                                                                |
| **RuntimeAdapterDescriptor** | Adapter's runtime descriptor. Has `create(stack)` and `lower(queryAST)`. Lowers Prisma queries to IDB plan bodies.                                                                                                                                                                                                                 |
| **pack**                     | The plain identity object for a target: `{ kind, familyId, targetId, id, version, capabilities }`. The default export of any target package.                                                                                                                                                                                       |
| **familyId**                 | Identifies the database family. For us: `'idb'`. For Mongo: `'mongo'`.                                                                                                                                                                                                                                                             |
| **targetId**                 | Identifies the specific target within a family. For a single-target family: same as `familyId`.                                                                                                                                                                                                                                    |
| **capabilities**             | A typed object on the pack declaring what the target can/cannot do (e.g. `transactionalDDL`, `returning`, `compoundKeys`). The framework uses this to gate features.                                                                                                                                                               |
| **codec**                    | A serializer/deserializer for a single scalar type. e.g. a `DateTime` codec converts between JS `Date` and whatever IDB stores.                                                                                                                                                                                                    |
| **codec registry**           | A collection of codecs for all scalar types the target supports. Returned by `RuntimeTargetDescriptor.codecs()`.                                                                                                                                                                                                                   |
| **codec ID**                 | A versioned string ID for a codec, e.g. `idb/date@1`. The `@1` is the version — different versions of the same codec can coexist.                                                                                                                                                                                                  |
| **scalarTypeDescriptors**    | The map on `ControlAdapterDescriptor` from Prisma type names (`'DateTime'`) to codec IDs (`'idb/date@1'`).                                                                                                                                                                                                                         |
| **marker store**             | The internal `_prisma_next_marker` object store that holds one `ContractMarkerRecord` per contract space (just `"app"` for now), keyed by `space`. Tracks which contract the database is currently in. Created by the planner's `createMarkerStoreOp` as the first op of the baseline migration.                                   |
| **ContractSpace**            | The framework's `{ contractJson, migrations, headRef }` value the browser-side runtime walks. Built at design time by `prisma-idb migration contract-space`; consumed by `createAutoMigratingIdbClient`.                                                                                                                           |
| **MigrationCLI**             | Shim invoked from the last line of every `migration.ts` (`MigrationCLI.run(import.meta.url, M);`). When the file is run as `node migration.ts`, regenerates `ops.json` + `migration.json` from the migration class's current `operations` getter and `describe()`. When merely imported (by `contract-space.generated.ts`), no-op. |
| **preflight**                | The `prisma-idb migration preflight` command that walks the chain empty→tip against a fresh `fake-indexeddb` instance — the only legitimate use of `fake-indexeddb` in the toolchain.                                                                                                                                              |
| **upgradeneeded**            | The IDB callback that fires when `IDBFactory.open(name, newVersion)` is called with a version higher than the stored version. DDL (object store creation/deletion) can ONLY happen here.                                                                                                                                           |
| **opaque plan body**         | The output of `adapter.lower(queryAST)`. It's a data structure the driver knows how to execute, but the adapter doesn't need to know the driver's internals to produce it.                                                                                                                                                         |
| **ORM client**               | The typed object returned by `idbOrm({ contract, executor })`. Maps contract roots to `IdbStoreAccessor` instances. The user-facing query API.                                                                                                                                                                                     |
| **store accessor**           | A per-model typed query builder returned by the ORM client. Has methods like `create()`, `all()`, `where()`, `first()`, `findUnique()`, `delete()`.                                                                                                                                                                                |
| **groupingKey**              | A unique string (e.g. `"idb-op-1"`) attached to every plan emitted by the ORM. Propagates through sub-plans so middleware can correlate related operations.                                                                                                                                                                        |
| **contract marker**          | A record in the `_prisma_next_marker` object store containing `storageHash`, `profileHash`, and `updatedAt`. Written by the migration runner, verified by `runtime.verifyMarker()`.                                                                                                                                                |
| **outbox sync**              | The bidirectional sync extension (separate from these packages). Client writes go to an outbox first; a background process syncs them to the server. Lives in a separate `extension-outbox-sync` package.                                                                                                                          |

---

## What We Are NOT Building

To keep scope clear:

- **No `@prisma-idb/idb` facade** — there is no user-facing one-package wrapper. Users compose the runtime stack directly.
- **No codegen in these packages** — the existing `packages/generator` still handles code generation via `@prisma/generator-helper`. These packages are the Prisma 8 SPI implementation.
- **No SQL** — IDB is a document/key-value store. There is no SQL surface here. The adapter lowers directly from Prisma's ORM query AST to IDB cursor operations.

---

## File Structure (target state)

```
packages/prisma-orm/
├── target-idb/
│   ├── package.json          ← exports: . /pack /control /runtime /migration
│   ├── tsconfig.json
│   └── src/
│       ├── core/
│       │   ├── descriptor-meta.ts      ← { kind, familyId, targetId, capabilities }
│       │   ├── codec-types.ts          ← codec ID + trait constants
│       │   ├── codecs.ts               ← codec implementations (idb/string@1, idb/date@1, …)
│       │   ├── idb-contract-types.ts   ← IdbStorage / IdbStoreDefinition / IdbIndexDefinition / type maps
│       │   ├── idb-migration.ts        ← `IdbMigration` base class (extends framework Migration)
│       │   ├── migration-cli.ts        ← `MigrationCLI.run` self-emit shim
│       │   ├── migration-factories.ts  ← createObjectStoreOp / createIndexOp / drop variants / marker store op
│       │   ├── migration-driver.ts     ← `IdbMigrationControlDriver` (carries factory + dbName + targetVersion)
│       │   ├── migration-planner.ts    ← contract→schema IR diffing + class-based migration.ts renderer
│       │   ├── migration-runner.ts     ← `IdbMigrationRunner` (execute() + refusal envelope for executeAcrossSpaces)
│       │   ├── apply-ddl-op.ts         ← shared `applyOneDdlOp` / `openAndUpgrade` / `readMarker` / `writeMarker`
│       │   └── schema-diff.ts          ← contract-to-contract diffing (with index-mutation handling)
│       └── exports/
│           ├── pack.ts        ← default export: idbTargetDescriptorMeta
│           ├── control.ts     ← IdbControlTargetDescriptor (binds the migrations capability)
│           ├── runtime.ts     ← RuntimeTargetDescriptor (codecs + create) + idbCodecLookup
│           └── migration.ts   ← re-exports authoring surface: Migration + MigrationCLI + DDL op factories + apply helpers
│
├── adapter-idb/
│   ├── package.json          ← exports: /control /runtime
│   ├── tsconfig.json
│   └── src/
│       ├── core/
│       │   ├── descriptor-meta.ts        ← adapter identity (familyId/targetId/kind)
│       │   ├── idb-adapter.ts            ← lower(plan, ctx) → IdbPlanBody
│       │   ├── idb-filter-expr.ts        ← IdbFilterExpr discriminated union + factories
│       │   ├── filter-eval.ts            ← evaluateFilter(expr, row) → boolean
│       │   ├── idb-query-ast.ts          ← IdbQueryAst (findMany / findUnique / create / delete / update / …)
│       │   ├── idb-query-plan.ts         ← IdbQueryPlan shape
│       │   └── runtime-adapter-instance.ts ← IdbRuntimeAdapterInstance + IdbLowererContext
│       └── exports/
│           ├── control.ts    ← ControlAdapterDescriptor + scalarTypeDescriptors
│           └── runtime.ts    ← RuntimeAdapterDescriptor + lower()
│
├── driver-idb/
│   ├── package.json          ← exports: /control /runtime
│   ├── tsconfig.json
│   └── src/
│       ├── core/
│       │   ├── descriptor-meta.ts  ← driver identity
│       │   ├── plan-body.ts        ← IdbPlanBody union, MARKER_STORE_NAME, IdbMarkerRecord, IdbScanWritePlan, IdbBatchPlan
│       │   ├── idb-driver.ts       ← IdbRuntimeDriverInstance (open + onversionchange, execute, readMarker, transaction, close)
│       │   ├── transaction-scope.ts ← IdbTransactionScope + createTransactionScope
│       │   └── execute/            ← plan body execution helpers (callback-driven, event-loop-safe)
│       └── exports/
│           ├── control.ts    ← idbControlDriverDescriptor (no-op stub; satisfies Config schema for IDB projects)
│           └── runtime.ts    ← createIDBRuntimeDriver() factory + IdbRuntimeDriverInstance + IdbTransactionScope
│
├── runtime-idb/
│   ├── package.json          ← exports: ./runtime
│   ├── tsconfig.json
│   ├── vitest.config.ts
│   ├── test/
│   │   └── runtime.test.ts
│   └── src/
│       ├── idb-runtime.ts       ← IdbRuntimeImpl (extends RuntimeCore), createIdbRuntime(), contentHash() for cache middleware
│       ├── idb-middleware.ts    ← IdbMiddleware interface (familyId?: "idb")
│       └── exports/
│           └── runtime.ts       ← re-exports createIdbRuntime, IdbRuntime, IdbMiddleware
│
├── client-idb/
│   ├── package.json          ← exports: ./orm ./client ./client-auto
│   ├── tsconfig.json
│   ├── vitest.config.ts
│   ├── test/
│   │   ├── auto-migrate-evolution.test.ts ← v1→v2→v3 evolution against contractSpace
│   │   ├── mutation-scope.test.ts         ← withMutationScope multi-store atomicity
│   │   ├── operators.test.ts              ← filter operator surface
│   │   └── orm.test.ts                    ← ORM terminals end-to-end
│   └── src/
│       ├── core/
│       │   ├── auto-migrate.ts     ← walkChain + openAndReadMarker + SAFE_POLICY (refuse destructive)
│       │   ├── filters.ts          ← and / or / not user-facing helpers
│       │   ├── idb-client.ts       ← createIdbClient() assembly + withTransaction
│       │   ├── idb-orm.ts          ← idbOrm() factory, IdbOrmClient type
│       │   ├── model-accessor.ts   ← createModelAccessor() Proxy for callback-form .where()
│       │   ├── mutation-scope.ts   ← withMutationScope() + IdbQueryExecutorWithTransaction
│       │   ├── relation-mutator.ts  ← createRelationMutator() + isRelationMutation{Descriptor,Callback} (Phase 6.4)
│       │   ├── mutation-executor.ts ← nested create/update graph walk: parse → partition → createGraph/updateFirstGraph (Phase 6.4)
│       │   ├── store-accessor.ts   ← IdbStoreAccessorImpl (create, all, where, first, update, upsert, nested writes, …)
│       │   ├── executor.ts         ← IdbQueryExecutor interface
│       │   ├── relation-loader.ts  ← include() / relation traversal (batch FK strategy)
│       │   ├── store-state.ts      ← per-accessor filter/orderBy/skip/take state
│       │   └── types.ts            ← IdbContract, WhereFilter, CreateInput, etc.
│       └── exports/
│           ├── orm.ts              ← idbOrm + types
│           ├── client.ts           ← createIdbClient (bring-your-own contract, no migration)
│           └── client-auto.ts      ← createAutoMigratingIdbClient (walks contractSpace.migrations)
│
└── family-idb/
    ├── package.json          ← exports: /control /pack /contract-ts /config-types + bin: prisma-idb
    ├── tsconfig.json
    └── src/
        ├── bin/
        │   └── prisma-idb.ts  ← CLI binary: generate-baseline | generate-contract-space | preflight
        ├── core/
        │   ├── chain-order.ts          ← chainOrderByMetadata() — walk from→to edges to derive package order
        │   ├── contract-builder.ts     ← defineContract() TS-first authoring
        │   ├── contract-space-codegen.ts ← generate-contract-space implementation
        │   ├── control-descriptor.ts   ← IdbFamilyDescriptor
        │   ├── control-instance.ts     ← createIdbFamilyInstance() — refusal envelopes for CLI methods
        │   ├── emission.ts             ← contract.d.ts emission plugin (used by prisma contract emit)
        │   ├── generate-baseline.ts    ← generate-baseline implementation
        │   ├── preflight.ts            ← preflight (walks chain against fake-indexeddb)
        │   ├── schema-ir.ts            ← IdbSchemaIR / IdbStoreIR / IdbIndexIR
        │   ├── schema-verify.ts        ← verifyIdbSchema (pure)
        │   └── validate.ts             ← validateContract (pure)
        └── exports/
            ├── control.ts       ← IdbFamilyDescriptor (default)
            ├── pack.ts          ← pure family pack ref for contract authoring
            ├── contract-ts.ts   ← defineContract
            └── config-types.ts  ← defineConfig + typescriptContract
```
