# @prisma-idb/sync-server

Server-side sync ownership DAG (ADR 014). Given a `rootModel` (e.g. `User`), builds an authorization graph from the contract's relations at startup, then resolves per-record ownership checks for push validation and pull scoping. Transport-agnostic: it never touches a database or an HTTP framework — `validatePush`/`buildPullQueries` return _descriptions_ of what to check, and the caller executes them against whatever storage it uses.

Never ships to the browser — this is server-only logic, built specifically so client bundles never carry authorization decisions (see ADR 014's rationale).

**Family-agnostic.** The DAG only ever walks `contract.domain` — model names, relations — which is identical in shape across every family (IDB, SQL, Mongo, whatever). The one thing that genuinely varies by family is how a model's primary key is stored (IDB: `storage.keyPath`, a string or — since Phase 9.1 — an array of field names for a compound key; SQL: a possibly-compound `primaryKey.columns` array living on the table, not the model), so that's the one pluggable extension point — `createSyncServer`'s `getKeyField` option. The default resolver only supports IDB's single-field-string shape and throws (asking for an explicit `getKeyField`) on anything else, including an IDB compound (array) `keyPath` — sync-server doesn't support compound-key models yet (this package still ships under the `@prisma-idb/*` namespace, and IDB-shaped contracts are the zero-config path), but nothing in the core DAG/path-resolution logic imports an IDB type, and there's no dependency on `target-idb` outside the test suite.

## Installation

```bash
pnpm add @prisma-idb/sync-server
```

## Quick Start

```ts
import { createSyncServer } from "@prisma-idb/sync-server";
import { domainModelsAtDefaultNamespace } from "@prisma/orm-framework/contract/types";
import { postgresContract } from "./prisma/schema.postgres.generated"; // the real server contract
import { clientContract } from "./prisma/contract"; // the browser's IDB contract

const syncServer = createSyncServer({
  contract: postgresContract, // full server contract (ADR 012) — includes client-excluded models
  clientContract, // client-projected contract (ADR 012) — defines what's ever synced
  rootModel: "User",
  // Required for a SQL contract — the default getKeyField assumes IDB's flat
  // storage.keyPath, which postgresContract doesn't have. See the API section
  // below for the full resolver.
  getKeyField: (contract, modelName) => {
    const model = domainModelsAtDefaultNamespace(contract.domain)[modelName]!;
    const table = (model.storage as { table: string; namespaceId: string }).table;
    const ns = (model.storage as { namespaceId: string }).namespaceId;
    const columns = contract.storage.namespaces[ns]!.entries.table[table]!.primaryKey.columns;
    if (columns.length !== 1) throw new Error(`Compound keys aren't supported here (model "${modelName}")`);
    return columns[0]!;
  },
});

// Push: resolve what each outbox event needs authorized.
const pushChecks = syncServer.validatePush(events, { scopeKey: currentUserId });
for (const { eventId, check } of pushChecks) {
  if (check.kind === "unknown-model") throw new PermanentSyncError("INVALID_MODEL", eventId);

  // Authorize, write, and record the changelog row in ONE transaction —
  // ownership check last, immediately before the write it authorizes, not
  // before the transaction opens. Otherwise the record's ownership chain
  // (e.g. a Board.userId) could be reassigned in the gap between the check
  // and the write it was meant to gate (ADR 014's transactional boundary).
  await prisma.$transaction(async (tx) => {
    if (check.kind === "root") {
      if (!check.authorized) throw new PermanentSyncError("SCOPE_VIOLATION", eventId);
    } else {
      // check.kind === "scoped" — authorized via ANY ONE path resolving to scopeKey.
      // Promise.all + some, not Promise.any: Promise.any resolves on the first
      // *fulfilled* promise regardless of its value, so a path that legitimately
      // resolves to `null` (not found) would short-circuit before a later path
      // that does resolve — silently rejecting a valid ownership chain.
      const pathResults = await Promise.all(
        check.paths.map((path) => findFirstAlongPath(tx, /* model */ eventModel, check.key, path, check.scopeKey))
      );
      if (!pathResults.some(Boolean)) throw new PermanentSyncError("SCOPE_VIOLATION", eventId);
    }

    await applyEvent(tx, eventModel, event); // the actual write
    await tx.changelog.create({ data: { model: eventModel, scopeKey: currentUserId /* ... */ } });
  });
}

// Pull: `logs` must already be pre-filtered to this caller (see "Pull is two
// steps" below) — buildPullQueries does the live re-check, not the initial fetch.
const scoped = syncServer.buildPullQueries(logs, { scopeKey: currentUserId });
```

## Pull is two steps — `buildPullQueries` is only the second one

`sync-server` doesn't fetch changelog rows; the caller does. The expected shape mirrors the old generator's `pullAndMaterializeLogs`:

1. **Cheap pre-filter, on the caller's own changelog storage.** Stamp the resolved `scopeKey` onto each changelog row at push time (right after `validatePush` authorizes it — reuse the same `scopeKey` you passed in, don't recompute it), then query `WHERE scopeKey = ? AND id > lastChangelogId`. This is an index-friendly filter over the caller's own storage; `sync-server` has no opinion on it and never sees it.
2. **Live re-check, via `buildPullQueries`.** For every row step 1 returned, resolve its current `OwnershipCheck` and have the caller execute it (`findFirst` down `check.paths`, or the root-key comparison) _before_ returning the record. This is not redundant with step 1 — it re-derives ownership from the record's live relations, not from what was stamped at push time.

Step 2 exists because a stamped `scopeKey` is a snapshot, and ownership can move after it's taken. Example, kanban:

- Alice creates `Todo T1` under `Board B1`, which she owns. Push authorizes it (`T1 → board → owner === "alice"`), and the caller stamps `scopeKey: "alice"` on that changelog row.
- Later, `B1` is reassigned to Bob (`Board.update({ owner: "bob" })`).
- Alice pulls. Step 1's flat filter (`scopeKey: "alice"`) still returns `T1`'s changelog row — it was true when it was written. Without step 2, Alice's client would materialize `T1` as if she still owned it.
- Step 2 re-resolves live: `check.paths` (`[["board", "owner"]]`) now points at Bob, not Alice, so the caller's query for `T1` scoped to `"alice"` returns nothing — the caller treats that as "no longer accessible" instead of serving stale access.

`SyncPullLogEntry` deliberately has no `scopeKey` field — it isn't `sync-server`'s job to know how you filter your changelog, only to tell you, per row, what's still true right now.

**Known limitation:** this only converges correctly for domains where ownership never shifts away from an already-synced client (e.g. this repo's own MyFit — a user's data is never handed to another user). If a record's ownership chain is reassigned after a client has already synced it, and that client has no further changelog rows of its own pending for it, that client will never receive another row about it — its stale local copy just sits there, even while online. See ADR 014's "Known limitation" section for why, and the deferred live-filter alternative (Firestore/Zero-style) that would fix it for domains that need reassignment safety.

## Schema: no more hand-authored `Changelog` model

The old generator required a `Changelog` model + `ChangeOperation` enum hand-typed into your `schema.prisma`, and threw one of a dozen validation errors (wrong type, missing `@unique`, extra field, ...) if it drifted from the exact expected shape. `sync-server/schema` owns that shape instead.

`Changelog` has to live wherever your server's data actually lives — a real Postgres database, in a normal deployment (never IndexedDB: it's a browser-only storage engine, so an "IDB as the server too" path never made sense as a real target, and this package doesn't offer one). For Postgres, `@prisma-idb/sync-server/postgres`'s `defineConfig` takes the _same_ `schema.prisma` your IDB client config already parses and does the rest — strips `@idb.exclude`/`@@idb.exclude` (meaningless to a real server, and the SQL family's parser hard-errors on that unrecognized namespace otherwise), appends a SQL-flavored `Changelog` (real enum, real DB-generated `autoincrement()` id), and wires the SQL family/Postgres target/adapter/driver descriptors — all entirely in memory, no generated `.prisma` file lands on disk:

```ts
// prisma.config.postgres.ts
import { definePrismaConfig } from "@prisma/cli-engine";
import { defineConfig } from "@prisma-idb/sync-server/postgres";

export default definePrismaConfig({
  orm: defineConfig({
    schema: "src/lib/prisma/schema.prisma",
    // Explicit: the default derives from the schema's own directory
    // (src/lib/prisma/contract.json), which collides with the IDB side's
    // own contract.json living in the same directory.
    output: "src/lib/prisma/schema.postgres.generated.json",
    db: { connection: process.env.DATABASE_URL },
  }),
});
```

`createSyncServer`'s `contract` can then be this real Postgres contract directly (with a `getKeyField` override — see the API section above) — no IDB-shaped stand-in needed just to feed the DAG.

**Upgrading from a hand-authored `Changelog`:** delete the `Changelog` model and `ChangeOperation` enum from `schema.prisma` before switching to `sqlContractWithSync`/this facade. Both are appended for you — leaving your own declarations in place produces duplicate PSL declarations, which fail contract generation.

### Other targets, or composing your own config

`@prisma-idb/sync-server/postgres` is a thin wrapper around `sqlContractWithSync`, the lower-level, target-agnostic building block. Reach for it directly if you're on a different SQL target, need `extensions`, or otherwise need control the facade doesn't expose:

```ts
// prisma.config.postgres.ts — the manual wiring the facade above does for you
import { definePrismaConfig } from "@prisma/cli-engine";
import { defineConfig } from "@prisma/orm-framework/config/config-types";
import postgresAdapter from "@prisma/orm-postgres/adapter/control";
import postgresDriver from "@prisma/orm-postgres/driver/control";
import sql from "@prisma/orm-postgres/family/control";
import { PG_INT_CODEC_ID, PG_TEXT_CODEC_ID } from "@prisma/orm-postgres/target/codec-ids";
import postgres from "@prisma/orm-postgres/target/control";
import postgresPackRef from "@prisma/orm-postgres/target/pack";
import { postgresCreateNamespace } from "@prisma/orm-postgres/target/types";
import { sqlContractWithSync } from "@prisma-idb/sync-server/schema";

export default definePrismaConfig({
  orm: defineConfig({
    family: sql,
    target: postgres,
    adapter: postgresAdapter,
    driver: postgresDriver,
    contract: sqlContractWithSync("src/lib/prisma/schema.prisma", {
      target: postgresPackRef,
      createNamespace: postgresCreateNamespace,
      enumInferenceCodecs: { text: PG_TEXT_CODEC_ID, int: PG_INT_CODEC_ID },
      // Explicit: the default derives from the schema's own directory
      // (src/lib/prisma/contract.json), which collides with the IDB side's
      // own contract.json living in the same directory.
      output: "src/lib/prisma/schema.postgres.generated.json",
    }),
    db: { connection: process.env.DATABASE_URL },
  }),
});
```

There's no `injectSchemaText`-style hook on the SQL family's own schema loader to plug this into directly (`family-idb`'s `prismaIdbContract` has one; the SQL family's `prismaContract` doesn't — see [prisma/orm#30115](https://github.com/prisma/orm/issues/30115)), so `sqlContractWithSync` decomposes `prismaContract()` into its component parts and substitutes an in-memory `load()` instead. The one cost is that it needs the core `defineConfig` wired by hand, as above — a target's own convenience `defineConfig` (e.g. `@prisma/orm-postgres/config`) only accepts a schema _path_ for `contract`, since it builds its own internal `prismaContract(...)` call, so it can't take a `ContractConfig` directly. `@prisma-idb/sync-server/postgres` exists precisely to hide this wiring for the common Postgres case.

`prepareSqlSchemaWithSync` (pure text in, text out, no file I/O) and `injectChangelogModelSql` (just the `Changelog` append, no stripping) are also exported on their own, for building against a schema loader `sqlContractWithSync` doesn't target directly.

## Why "descriptions", not query results

`sync-server` doesn't know Prisma, SQL, or any specific storage engine — `contract.storage` shape aside, the actual `findFirst`/equivalent lookup is the caller's job. `check.paths` is a list of relation-name chains (e.g. `["todo", "board", "owner"]`); the caller is responsible for turning each chain into a real nested query (or however their storage layer expresses "traverse these relations, then compare the root's key to `scopeKey`") and interpreting a miss as unauthorized.

## API

### `createSyncServer({ contract, clientContract, rootModel, getKeyField? })`

Builds the ownership DAG once — throws immediately on a broken schema (a cycle, or a client-synced model with no relation chain back to `rootModel`) rather than per-request. `contract`/`clientContract` can be any family's `Contract` — a real Postgres/SQL contract works directly, no IDB-shaped intermediary needed. Returns a `SyncServer`:

- `validatePush(events, { scopeKey })` — resolves an `OwnershipCheck` per event.
- `buildPullQueries(logs, { scopeKey })` — resolves an `OwnershipCheck` per changelog row.

`getKeyField?: (contract, modelName) => string` resolves a model's primary-key field name. Defaults to `defaultGetKeyField`, which duck-types IDB's flat `storage.keyPath` — works for any IDB-shaped contract with zero config. For a family whose storage shape differs (SQL's key lives on the table's `primaryKey.columns`, potentially compound), pass your own:

```ts
import { createSyncServer } from "@prisma-idb/sync-server";
import { domainModelsAtDefaultNamespace } from "@prisma/orm-framework/contract/types";

const syncServer = createSyncServer({
  contract: postgresContract, // the real server contract — no IDB intermediary
  clientContract: idbClientContract, // still the browser's IDB contract
  rootModel: "User",
  getKeyField: (contract, modelName) => {
    const model = domainModelsAtDefaultNamespace(contract.domain)[modelName]!;
    const table = (model.storage as { table: string; namespaceId: string }).table;
    const ns = (model.storage as { namespaceId: string }).namespaceId;
    const columns = contract.storage.namespaces[ns]!.entries.table[table]!.primaryKey.columns;
    if (columns.length !== 1) throw new Error(`Compound keys aren't supported here (model "${modelName}")`);
    return columns[0]!;
  },
});
```

### `OwnershipCheck`

| `kind`            | Meaning                                                                                                  |
| ----------------- | -------------------------------------------------------------------------------------------------------- |
| `"unknown-model"` | The model isn't in `clientContract` — a real client could never have produced this. Reject outright.     |
| `"root"`          | The record _is_ the root model — `authorized` is already computed (`key === scopeKey`), no query needed. |
| `"scoped"`        | Non-root record — authorized if _any one_ of `paths` resolves to `scopeKey` when the caller queries it.  |

### Lower-level exports

- `buildOwnershipDag(contract, clientContract, rootModel)` — the DAG construction + validation on its own.
- `resolveAuthorizationPaths(contract, rootModel, modelName)` — every relation-name chain from `modelName` to `rootModel`, shortest first.
- `defaultGetKeyField` — the default IDB-shaped resolver `createSyncServer` uses when `getKeyField` is omitted, exported so a custom resolver can fall back to it for models that _are_ IDB-shaped in a mixed setup.

### `@prisma-idb/sync-server/postgres`

- `defineConfig({ schema, output?, db?, migrations? })` — the Postgres facade: wires `@prisma/orm-postgres`'s family/target/adapter/driver descriptors and `sqlContractWithSync` through the core `defineConfig` for you. `schema` is the path to the shared `schema.prisma`.

### `@prisma-idb/sync-server/schema`

- `sqlContractWithSync(schemaPath, options)` — reads, prepares, and interprets the real server schema entirely in memory; returns a `ContractConfig` for the core `defineConfig`'s `contract:`. `options` is forwarded to the SQL family's own `prismaContract`. What `@prisma-idb/sync-server/postgres` uses internally — reach for this directly for a non-Postgres target or when you need control the facade doesn't expose.
- `prepareSqlSchemaWithSync(schema)` — the pure text transform underneath (strip `@idb.exclude`/`@@idb.exclude` + append `Changelog`), no file I/O.
- `injectChangelogModelSql(schema)` — just the `Changelog` append, no stripping.
