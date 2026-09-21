# ADR 014 — Sync Ownership DAG

## Context

The outbox pattern (`sync-executor.ts`) makes local writes durable and retryable, but it says nothing about whether a given write is one the _pusher is allowed to make_. A malicious or buggy client can put anything in its outbox — `{ model: "Comment", operation: "update", payload: { id: "someone-elses-comment", body: "..." } }` — and without a check, the push endpoint will happily materialize it into the shared changelog. Symmetrically, pull has to answer "which rows does this client get to see," not just "which rows exist."

The old generator solved both with a single mechanism: a `rootModel` (e.g. `User`) designated in generator config, an ownership DAG built from every model's relations back to that root (`createDAG.ts`), and, for any non-root model, _every_ structural path back to root (`buildAllAuthorizationPaths`, not just the shortest — a model can be reachable through more than one relation chain, and any valid chain should authorize it). Push validates a record's chain resolves to the pusher's `scopeKey`; pull's `findFirst`/`findUnique` queries are built directly from the same paths (`create.ts:290-343`).

Two things from the Will Madden conversation and the framework docs bear on where this lives:

- **`model.owner` is not this.** ADR 177 (upstream) defines `owner` as aggregate membership — "this model's data is physically co-located with its owner's storage" (embedded doc, JSONB column). It's a storage-locality fact, computed once, structural. The sync `rootModel` DAG is an _authorization_ fact — "this row is only visible to/writable by whoever owns the root record it chains back to" — evaluated per-request against a caller's identity, not structural. Reusing `owner` for both would silently conflate "lives inside" with "is gated by," which are different questions with different answers for plenty of real schemas (e.g. a `Comment` might not be storage-owned by `Post` in Mongo's embedding sense at all, while still needing to be _authorization_-scoped to the `Post`'s author).
- **This is server-side, full stop.** Nothing about push validation or pull scoping runs in the browser — the client doesn't decide what it's allowed to see or write, the server does. This matters for where the DAG code lives (never shipped to `sync-extension-idb`, which is browser-bundled) and confirms the "ship a sync-server package" decision isn't just packaging preference — it's the only place this logic is _allowed_ to run.

## Decision

### A new `@prisma-idb/sync-server` package, transport-agnostic

Not coupled to Prisma Client, not coupled to any HTTP framework. It takes a contract (the _server_-side one from ADR 012 — the DAG needs the full model graph, including anything excluded from the client) and a `rootModel` name, and exposes:

```ts
const syncServer = createSyncServer({ contract, rootModel: "User" });

// Push: validate + return per-event results, caller executes the writes
const results = syncServer.validatePush(events, { scopeKey });

// Pull: build the scoped WHERE-shape for each changelog row, caller executes the reads
const scopedQueries = syncServer.buildPullQueries(logs, { scopeKey });
```

`validatePush`/`buildPullQueries` return _descriptions_ of what to check/query, not query results — the actual DB access (Prisma Client, raw SQL, whatever the server uses) stays the caller's responsibility. This is the "transport-agnostic" boundary: `sync-server` knows the shape of authorization, not how to talk to Postgres.

### The DAG is built at runtime, from the contract, every server start

No generated file. `buildOwnershipDag(contract, rootModel)` walks `contract.domain.models[*].relations` once at `createSyncServer()` time — the same "derive from contract.domain, no executable codegen" pattern `decodeJsonRecord` (`target-idb/src/core/decode-json-record.ts`) already established for wire decoding. Construction re-derives `createDAG.ts`'s two invariant checks against the new relation shape:

- **Root reachability** — every model must have a path of required relations back to `rootModel` (BFS over the reverse graph, `createDAG.ts:27-61`'s algorithm, walking `model.relations` instead of DMMF object fields).
- **Acyclicity** — the ownership graph itself (required N:1 edges) must not cycle (`createDAG.ts:63-89`'s algorithm, same graph shape).

Both checks throw at `createSyncServer()` construction, not per-request — a broken DAG is a deploy-time configuration error, not a runtime one, matching the old generator's fail-fast-at-codegen posture just moved to fail-fast-at-boot (since there's no codegen step left to fail at).

### Push validation

For each outbox event: resolve every authorization path from `event.model` to `rootModel` (all paths, not just shortest — same reasoning as the old generator, a model can legitimately chain to root through more than one relation). Build the flat WHERE-shape combining the record's own key with _any one_ path resolving to `scopeKey`. The caller executes it (`findFirst`); a miss means `SCOPE_VIOLATION`. Record-shape validation (does the payload match the contract) is ADR 015's job, run first — a malformed payload never reaches DAG resolution.

**The caller's authorization check, mutation, and changelog write must run inside one transaction**, ownership check last (immediately before the write it authorizes) — not before the transaction opens. `sync-server` itself never touches a database, so it can't enforce this; it's a requirement on the caller's execution half (see the README's push example). Checking ownership outside the transaction leaves a window where the record's ownership chain (e.g. a `Board.userId`) could be reassigned between the check and the write it was meant to authorize.

### Pull scoping

Symmetric: for the root model, the row's own key must equal `scopeKey` directly (no chain needed, it _is_ the root). For every other model, `buildPullQueries` emits the same multi-path WHERE-shape push validation uses, so a client can never pull a row it couldn't have legitimately pushed.

## Why not fold this into `sync-extension-idb`

`sync-extension-idb` is client-side and browser-bundled. Ownership/ authorization logic in a browser bundle is dead weight at best (it's re-derivable from the contract the browser already has, so it teaches an attacker nothing they didn't already know) and a false sense of security at worst if anyone mistakes client-side filtering for enforcement. The framework's own migration-planner-in-the-browser mistake (`FEEDBACK.md` items 1-2) is the cautionary precedent: anything that's a server-authoritative decision shouldn't ship to every client just because the client _could_ compute it.

## Why "any one path," not "shortest path" or "all paths must hold"

A record legitimately reachable through relation A _or_ relation B should be authorized either way — requiring _all_ paths to resolve would incorrectly reject valid ownership through a secondary relation, and picking only the shortest would incorrectly reject valid ownership when the shortest path happens to be broken (e.g. a nullable FK on that particular row) while a longer path is intact. This is exactly the old generator's reasoning (`buildAllAuthorizationPaths` returns every path, sorted only for _query construction_ preference, not correctness).

## Consequences

- **`rootModel` becomes a required, validated config field** for any app using sync, exactly as in the old generator (`outboxSync && !rootModelString` throws at config time). It must survive ADR 012/013's projection on _both_ sides — the client contract needs the root model to exist too (the local outbox events need to be attributable), even though the DAG computation itself only runs server-side.
- **Multi-hop authorization paths mean push validation is O(paths × path length) reads per event**, not O(1). The old generator accepted this (a `findFirst` per event, in the worst case per path); we inherit the same cost profile until/unless there's a reason to optimize it.
- **No client-side authorization enforcement exists or is intended.** This ADR doesn't add anything to `sync-extension-idb`. A client can still construct an outbox event for data it doesn't own — it just won't push successfully. This is by design, not a gap: client-side state is inherently untrusted.
- **Doesn't reuse `model.owner`.** A schema author declaring both an `owner` (storage aggregate) and a `rootModel`-reaching relation chain (authorization) on the same model is normal and expected — they answer different questions and can point at different models entirely.

## Implementation notes

`createSyncServer` ended up taking **two** contracts, not the one the Decision section's sketch shows:

```ts
const syncServer = createSyncServer({
  contract, // full server contract (ADR 012) — used for graph edges
  clientContract, // client-projected contract (ADR 012) — defines what's ever synced
  rootModel: "User",
});
```

The reason is the root-reachability check's scope. "Every model must have a path back to `rootModel`" can't mean _every model in the full contract_ — a server-only model with no relations at all (this repo's own kanban-example `AuditLog`) would fail construction for no reason: it's `@@idb.exclude`'d, so it can never appear in an outbox event or a pull-scope check, and there's nothing to authorize. But it also can't mean _every model with at least one relation_, silently exempting anything relation-less — that would let a schema author forget `@@idb.exclude` on a genuinely-synced island model and never find out until a push for it mysteriously has no valid authorization path at runtime, instead of at boot.

The resolution: reachability is required for every model in `clientContract` (i.e. everything that survives ADR 012's projection) and only those — matching the old generator's behavior where `filteredModels` was, by construction, exactly the synced set. Server-only models stay in the graph as possible waypoints (a client model's chain may legitimately pass through one) but are exempt from having to reach root themselves. Forgetting `@@idb.exclude` on an island model still throws at `createSyncServer()` construction, same as the old generator's `Model "${node}" cannot reach root` — it just throws because the model is in `clientContract`, not because it's in `contract`.

`validatePush`/`buildPullQueries` also use `clientContract`'s model set as the base legitimacy check: an event or changelog row naming a model absent from it is rejected outright (`{ kind: "unknown-model" }`) before any DAG resolution — a real client can never have generated an event for a model it doesn't have locally.

### Pull is still two steps, same as the old generator — `buildPullQueries` is only the second one

The old generator's `pullAndMaterializeLogs` (`create.ts:259-343`) never relied on the DAG alone for pull. It first ran a cheap flat filter over `changelog` using a `scopeKey` column stamped onto each row at push time (`create.ts:271-283`, stamp at `534`/`727`/`796`), _then_, for every row that survived, re-ran the DAG-derived multi-path `findFirst` live (`create.ts:290-339`) before materializing the record. `sync-server` only replaces the second half. `SyncPullLogEntry` has no `scopeKey` field on purpose — the caller is expected to stamp `scopeKey` on their own changelog storage at push time (reusing the same value passed to `validatePush`, not recomputed) and pre-filter on it before ever calling `buildPullQueries`.

The reason the live re-check can't be dropped in favor of the stamped column alone: the stamp is a snapshot of ownership _at push time_, and ownership can move afterward. Kanban example — Alice creates `Todo T1` under `Board B1` (which she owns); the changelog row for that create gets `scopeKey: "alice"`. `B1` is later reassigned to Bob. Alice's next pull still matches the stamped-`scopeKey` filter (it was true when written), but `buildPullQueries`'s live `OwnershipCheck` for `T1` now resolves through `board.owner` to Bob, not Alice — so the caller's re-check query returns nothing, and the record is correctly treated as no-longer-accessible instead of served from stale ownership. A purely flat-filter pull (no step 2) would leak it.

On the client, `sync-extension-idb`'s `applyPull` treats a `create`/`update` log with `record: null` as a delete of the local copy (cascading the same way an explicit `delete` op does), not a no-op skip — a revoked record has to stop existing locally, not just stop updating.

### Known limitation: the actor-stamped `scopeKey` pre-filter assumes ownership never shifts away from an already-synced client

The stamped-`scopeKey` pre-filter (step 1 above) gates which changelog rows a client's pull ever _considers_ by who pushed the row — not by who's currently authorized to see it. Those are the same person until ownership moves. Once `B1` is reassigned to Bob, every future changelog row about it is stamped `scopeKey: "bob"`; Alice's `scopeKey: "alice"` pre-filter structurally excludes them, forever, not just until her next poll. If Alice has already pulled everything she authored about `B1` before the reassignment, no future row will ever reach her `applyPull` call again — the delete-on-null fix above only fires for rows that make it past step 1, and after a clean reassignment, none do. Her local copy of `B1` (and anything under it) goes stale with no further signal, even while she's online and polling normally.

This is fine — arguably correct — for a domain where ownership is permanent by construction (this repo's actual first consumer, MyFit: a user's workouts are never handed to another user). It's a real gap for a domain where reassignment is a normal operation (a Linear-shaped issue tracker: reassigning an issue, moving a project to another team).

Systems that need to handle this treat authorization as a _live filter re-evaluated per viewer on every relevant change_, not a fact stamped once by whoever wrote the record — e.g. Firestore's `REMOVED` watch-listener events when a document falls out of a query's authorized result, or Zero's (Rocicorp) permission model, where "select permissions act like filters" compiled into the same live query pipeline every other update flows through, so a row that stops matching a viewer's permissions is indistinguishable from a row that stops matching any other `WHERE` clause. Applied here, the fix would be: don't gate the pull candidate set by the pusher's stamped `scopeKey` at all — pull a bounded recent window across all activity for the client's contract models, and let `buildPullQueries` (already parameterized by the _requesting_ caller's `scopeKey`, not the original pusher's) decide per row, live, for every poll. That guarantees an online, regularly-polling client converges correctly regardless of who caused the change — at the cost of a live DAG re-check on every row in the window for every poller, not just the rows they authored.

Deliberately not implemented now — it's real complexity (a different pull contract, plus for high-cardinality systems it likely wants a coarse pre-partition first, e.g. Linear's `subscribedSyncGroups` workspace/team scoping, before the fine-grained live check runs) for a scenario the current primary consumer (MyFit) cannot hit. Left as a documented option: a future `pullStrategy: "scopeKey" | "live"` flag on `createSyncServer` (or equivalent) would let a consumer opt into the live-filter behavior above without changing it for consumers that don't need it, once a real second consumer actually needs reassignment-safe pull.

### Schema: `Changelog` as an authoring extension, not a hand-authored model

`Changelog` has to live wherever the _server's_ data actually lives. In a real deployment that's a Postgres/Mongo/whatever database — never IndexedDB, which is a browser-only storage engine and cannot run server-side at all. (An earlier draft of this package also offered an "IDB-as-server" path — `Changelog` living in the same browser-only IDB family as a self-contained app's only storage. Removed: it's not a real deployment target anyone would reach for, and it only existed because this repo hadn't grown a real SQL backend yet when this ADR was first implemented.)

The old generator required a `Changelog` model + `ChangeOperation` enum typed by hand into `schema.prisma`, validated field-by-field at generation time (`parseGeneratorConfig.ts`'s `validateChangelogSchema` — exact type, `@id`/`@default(uuid(7))`, `@unique`, no extra/missing fields — throwing one of a dozen distinct errors on drift). `prisma-next`'s architecture makes a better version of this possible: `@prisma-idb/sync-server/schema` exports `sqlContractWithSync`, which composes two steps against the schema.prisma a browser client already parses — `stripIdbExcludeAttributes` (family-idb's `idb.exclude` namespace means nothing to a real server, and the SQL family's parser hard-errors on the unrecognized namespace otherwise) then `injectChangelogModelSql` (a real enum, a real DB-generated `autoincrement()` id) — and hands the result straight to the SQL family's own parse/interpret pipeline, entirely in memory (no generated `.prisma` file). It works by decomposing the SQL family's `prismaContract()` into its component parts and substituting an in-memory `load()` ([prisma/orm#30115](https://github.com/prisma/orm/issues/30115)); the tradeoff is that it needs the core `defineConfig` wired by hand rather than a target's convenience wrapper (which only accepts a schema path). `@prisma-idb/sync-server/postgres` hides that wiring behind a single `defineConfig({ schema, output?, db?, migrations? })` for the Postgres case; `sqlContractWithSync` stays available directly for other targets. `prepareSqlSchemaWithSync` (the pure text transform, no file I/O) and `injectChangelogModelSql` are also exported standalone.

This isn't modeled as an upstream **Extension Pack** (ADR 112, upstream). That mechanism — `contract.extensions.<namespace>`, capability negotiation, canonicalized decorations/constructs — is purpose-built for _decorating existing contract nodes_ with vendor storage features (pgvector column types, PostGIS index types), validated and hashed as part of the pack SPI contract. `Changelog` is an ordinary first-class model with its own fields, not a decoration on something else, and this repo doesn't use the Extension Pack machinery anywhere (no `packages/3-extensions`, no registered capability namespace) — adopting it here would be a large, purpose-mismatched lift for what's actually a small problem.

The real constraint driving "text transform, not post-build contract splicing" is `storageHash`: it's computed _inside_ the family's own interpreter (`interpretPslDocumentToIdbContract`/the SQL family's equivalent), from the model set at that point, and downstream tooling (`schema-verify.ts`/`generate-migration.ts`/`control-instance.ts`) trusts it. Splicing `Changelog` into an already-built `Contract` (post-hash) would silently desync the hash from the actual model set — so the injection has to happen pre-parse, on the raw schema text, before either family's interpreter ever runs.

### Genuinely family-agnostic: `getKeyField` as the one extension point

`sync-server` originally typed `contract`/`clientContract` as `Contract<IdbStorage>` and read a model's primary key via `model.storage.keyPath` with a bare `as IdbModelStorage` cast — reasonable when this repo's kanban-example had no real backend and fed the DAG an IDB-emitted "full" contract purely for its relations. Once the kanban-example grew a real Postgres backend (`@prisma-next/postgres`, the real SQL family — not the earlier hand-rolled-SQL mistake), that assumption broke on contact: it's strictly better for `createSyncServer`'s `contract` to be the _actual_ server contract (Postgres) rather than a parallel IDB-shaped stand-in kept only to feed the DAG, and SQL's storage shape doesn't have a `keyPath` at all — the primary key lives on the table (`contract.storage.namespaces[ns].entries.table[table].primaryKey.columns`, a possibly-_compound_ array, not a flat model-level field).

The fix isn't "also support SQL" as a special case — it's recognizing that `buildOwnershipDag`/`resolveAuthorizationPaths` never actually needed IDB at all. Both walk `contract.domain.namespaces[ns].models[*].relations`, which is `@prisma-next/contract`'s own framework-level shape (`ContractRelation`, `on.localFields`, `to.model`) — identical across every family, because it's defined one layer below any of them. The _only_ family-specific piece was key-field extraction, so that's the only piece that's now pluggable:

```ts
export type GetKeyField = (contract: SyncServerContract, modelName: string) => string;
```

`SyncServerContract` is now plain `Contract` (no storage type parameter). `createSyncServer({ ..., getKeyField? })` defaults to `defaultGetKeyField`, which duck-types `model.storage.keyPath` as a string — no `IdbModelStorage` import, so it happens to match IDB's shape without depending on it; a contract whose storage doesn't expose a flat `keyPath` throws immediately, naming the option to supply, rather than silently misresolving. `@prisma-idb/target-idb` dropped from `sync-server`'s runtime dependencies entirely (moved to devDependencies — still needed to build IDB-shaped fixtures in tests).

Consequence for this repo's kanban-example: `prisma-next.config.server.ts` (the IDB-emulated "full" contract that existed solely to feed this DAG) is no longer needed — `createSyncServer` takes the real Postgres contract directly, with a `getKeyField` reading `primaryKey.columns` (rejecting compound keys explicitly, since nothing in this app's push/pull plumbing handles a composite `key` today — a real limitation, not silently ignored).

## Related

- ADR 012 — Client Contract Subsetting (the `rootModel` survival constraint on the client-side projection)
- ADR 013 — FK Projection on Excluded Models (root-reachability check runs against its survivor set)
- ADR 015 — Contract-Derived Validation (payload shape validation runs before DAG resolution on push)
- ADR 177 (upstream) — Ownership replaces relation strategy — the `model.owner` concept this ADR explicitly does not reuse
- ADR 112 (upstream) — Target Extension Packs — the formal extension mechanism `Changelog`'s schema injection deliberately does not use (purpose-mismatched: decorations on existing nodes, not new first-class models)
- `packages/generator/src/fileCreators/batch-processor/createDAG.ts` — direct algorithmic precedent (root reachability BFS, cycle detection)
- `packages/generator/src/helpers/parseGeneratorConfig.ts:233-390` — the old generator's hand-authored `Changelog`/`ChangeOperation` validation this schema-injection approach replaces
- `packages/generator/src/fileCreators/batch-processor/create.ts:22-60,290-343` — `buildAllAuthorizationPaths`, push/pull query construction precedent
- [Firestore watch listeners — `ADDED`/`MODIFIED`/`REMOVED` change types](https://cloud.google.com/firestore/docs/samples/firestore-listen-query-changes) — precedent for authorization-loss as an active signal, not silence
- [Zero (Rocicorp) permissions](https://zero.rocicorp.dev/docs/permissions) / [synced queries](https://zero.rocicorp.dev/docs/synced-queries) — precedent for permissions-as-live-query-filter, the model the deferred `pullStrategy: "live"` option above would follow
- [Reverse-engineered Linear sync engine](https://dev.to/wzhudev/i-reversed-linears-sync-engine-to-see-how-it-works-3cj) — `subscribedSyncGroups` coarse-partition precedent
- [Kleppmann, "Local-first software: you own your data, in spite of the cloud"](https://martin.kleppmann.com/papers/local-first.pdf) / [Ink & Switch Keyhive](https://www.inkandswitch.com/keyhive/notebook/) — revocation in local-first systems is bounded to "an honest, still-syncing client converges," not "the bytes are unrecoverable from disk"
- `target-idb/src/core/decode-json-record.ts` — precedent for "derive from `contract.domain` at runtime, no generated file"
- `packages/prisma-orm/docs/FEEDBACK.md` items 1-2 — the "don't ship server-authoritative logic to the browser" lesson this ADR applies to authorization
- Discord thread with Will Madden, 2026-06-10/11 — dual-DB-state discussion; scoping and migration-lifecycle questions
