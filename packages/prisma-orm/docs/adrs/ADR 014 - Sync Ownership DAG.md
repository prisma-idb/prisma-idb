# ADR 014: Sync ownership graph

- **Status:** Accepted, with a known limitation (see Consequences)
- **Date:** 2026-08-09
- **Area:** Sync (server side)

## Summary

The sync server decides who may push and pull each record by following relations from the record back to a root model, such as `User`. This set of paths is the ownership graph. It is built from the contract when the server starts. A record is allowed if any one of its paths leads to the caller's root record.

This logic lives in a separate package, `@prisma-idb/sync-server`, which never ships to the browser. It doesn't touch a database itself: it returns descriptions of the checks and queries, and the app runs them.

## Context

The outbox in `sync-extension-idb` makes local writes durable and retryable. It says nothing about whether the client is allowed to make them. A buggy or malicious client can put anything in its outbox, for example an update to someone else's comment. Without a check, the server would apply it. Pull has the matching problem: it must return only the rows this client may see, not every row that exists.

The old generator (`packages/generator`) solved both with one mechanism:

- A `rootModel`, such as `User`, set in the generator config.
- An ownership graph built from every model's relations back to that root.
- For each model, every path back to the root, not just the shortest one.

Push checked that a record's path led to the pusher's `scopeKey` (the id of the caller's root record). Pull built its queries from the same paths.

Two points shaped where this logic lives:

- **The framework's `model.owner` is a different concept.** Upstream ADR 177 uses `owner` for storage: this model's data is stored inside its owner's, for example as an embedded document. The sync root is about authorization: this row may only be seen or changed by whoever owns the root record it leads to. The two often point at different models. A `Comment` might not be stored inside its `Post`, but still be visible only to the post's author. Reusing `owner` would mix up "stored inside" with "access controlled by".
- **This must run on the server.** The client can't decide what it may see or write. So none of this belongs in `sync-extension-idb`, which is bundled for the browser.

## Decision

### A separate, transport-agnostic package

`@prisma-idb/sync-server` doesn't depend on any HTTP framework or database client:

```ts
const syncServer = createSyncServer({
  contract, // the full server contract (ADR 012), used for the relation graph
  clientContract, // the client contract (ADR 012), defines which models are synced
  rootModel: "User",
});

// Push: check each event, returning what the app must verify and write.
const results = syncServer.validatePush(events, { scopeKey });

// Pull: for each changelog row, return the ownership check the app must run.
const scopedQueries = syncServer.buildPullQueries(logs, { scopeKey });
```

Both functions return descriptions, not results. The app runs them against its own database, with Prisma, SQL or anything else.

### The graph is built from the contract at startup

There is no generated file. `buildOwnershipDag` walks every model's relations once, when `createSyncServer` runs. It checks two things, and throws if either fails:

- **Every synced model can reach the root.** Every model in `clientContract` must have a path of required relations to `rootModel`. Server-only models can appear partway along a path, but don't need their own path to the root. For example, the kanban example's `AuditLog` has no relations and is marked `@@idb.exclude`, so it is fine. A synced model with no path is almost always a missing `@@idb.exclude`, so it fails at startup rather than on its first push.
- **The graph has no cycles.**

A broken graph is a configuration error, so it fails when the server starts, not on a request.

### Push

For each outbox event:

1. If the event names a model that isn't in `clientContract`, reject it as `unknown-model`. A real client can't create events for models it doesn't have.
2. Find every path from the event's model to the root.
3. Build one check: the record's own key, plus any one of those paths leading to `scopeKey`. The app runs it. If nothing matches, the push is rejected as a scope violation.

Checking that the payload matches the contract comes first, before any of this. That is [ADR 015](ADR%20015%20-%20Contract-Derived%20Validation.md)'s job.

**The app must run the ownership check, the write and the changelog entry in one database transaction**, with the check immediately before the write. If the check ran before the transaction opened, the ownership chain could change in between, for example a board reassigned to another user. `sync-server` never touches the database, so it can't enforce this. The README's push example shows the right shape.

### Pull

For the root model, the row's own key must equal `scopeKey`. For every other model, `buildPullQueries` returns the same multi-path check that push uses. So a client can never pull a row it couldn't have pushed.

Pull has two steps, as in the old generator. `buildPullQueries` is only the second:

1. **Pre-filter the changelog.** When a push is accepted, the app stores its `scopeKey` on the changelog row. On pull, it first selects only rows with the caller's `scopeKey`. `SyncPullLogEntry` deliberately has no `scopeKey` field. Storing it and filtering on it is the app's job.
2. **Re-check ownership live.** For each remaining row, run the check from `buildPullQueries` against current data.

The live re-check is needed because ownership can change after the push. For example, Alice creates a todo on her board, and the changelog row is stored with `scopeKey: "alice"`. The board is then given to Bob. Alice's next pull still matches the stored `scopeKey`, but the live check now leads to Bob, so Alice's query finds nothing. Without step 2, Alice would still receive the todo.

When a record fails the live check, the server sends it with `record: null`. On the client, `applyPull` treats a `null` record as a delete, including cascades, rather than skipping it. A record the client may no longer see has to disappear locally.

### Any one path is enough

A record reachable through relation A or relation B should be allowed either way:

- **Requiring every path** would wrongly reject a record owned through a secondary relation.
- **Using only the shortest path** would wrongly reject a record whose shortest path happens to be broken, for example by a null foreign key on that row, while a longer path is intact.

The old generator worked the same way.

### Adding the `Changelog` model to the server schema

The `Changelog` table has to live in the server's database, never in IndexedDB. The old generator made developers type `Changelog` and `ChangeOperation` into `schema.prisma` by hand, and then validated them field by field.

Instead, `@prisma-idb/sync-server/schema` exports `sqlContractWithSync`. It takes the same `schema.prisma` the browser client uses and, in memory, before the SQL family parses it:

1. **Removes the `idb` attributes** (`stripIdbExcludeAttributes`). They mean nothing to the server, and the SQL parser rejects the unknown namespace.
2. **Adds a SQL `Changelog` model** (`injectChangelogModelSql`), with a real enum and a database-generated id.

No `.prisma` file is written. For Postgres, `defineConfig` from `@prisma-idb/sync-server/postgres` does all the wiring. `sqlContractWithSync`, `prepareSqlSchemaWithSync` (the pure text transform) and `injectChangelogModelSql` are also exported, for other targets.

This works by splitting the SQL family's `prismaContract()` into its parts and supplying an in-memory `load()` ([prisma/orm#30115](https://github.com/prisma/orm/issues/30115)). The cost is that the core `defineConfig` has to be wired by hand, because each target's convenience wrapper only accepts a schema path.

The model is added to the schema text, not to the built contract, because of `storageHash`. The family's interpreter computes the hash from the model set, and later tooling trusts it. Adding `Changelog` to an already-built contract would leave the hash out of date without anyone noticing.

### Working with any database family

`sync-server` only needs two things from a contract:

- **The relations.** These have the same shape in every family, because the framework defines them.
- **Each model's key field.** This is the only family-specific piece, so it is the only pluggable one:

```ts
export type GetKeyField = (contract: SyncServerContract, modelName: string) => string;
```

`SyncServerContract` is the framework's plain `Contract`. The default `getKeyField` reads `model.storage.keyPath` when it is a string, which matches IndexedDB contracts without importing IndexedDB types. For any other storage shape, it throws and names the `getKeyField` option. `sync-server` has no runtime dependency on `target-idb`.

So `createSyncServer` can take the real server contract directly. The kanban example passes its Postgres contract, with a `getKeyField` that reads the table's primary-key columns. It rejects compound keys explicitly, since nothing in the push and pull path handles them yet.

## Alternatives considered

- **Put this in `sync-extension-idb`.** That package runs in the browser. Authorization logic there would be useless, because the browser already has the contract, and misleading if anyone mistook client-side filtering for enforcement. Rejected.
- **Reuse `model.owner`.** It answers a different question, as explained in Context. Rejected.
- **Model `Changelog` as an upstream extension pack** (upstream ADR 112). Extension packs add storage features to existing contract nodes, such as pgvector column types. `Changelog` is a new, ordinary model. This repo doesn't use extension packs anywhere, and adopting them for this would be a large, poorly fitting change. Rejected.
- **Add `Changelog` to the built contract.** This would leave `storageHash` wrong, as explained above. Rejected.

## Consequences

- **Apps that sync must set `rootModel`.** It must survive the projection in [ADR 012](ADR%20012%20-%20Client%20Contract%20Subsetting.md) and [ADR 013](ADR%20013%20-%20FK%20Projection%20on%20Excluded%20Models.md) on both sides. `createSyncServer` throws if it is missing from either contract.
- **Push costs more reads.** Each event may need up to one read per path, and each path can span several relations. The old generator had the same cost. We'll optimise it if it becomes a problem.
- **There is no client-side authorization, by design.** A client can still put events for other users' data in its outbox. They just won't be accepted. Client state is never trusted.
- **`model.owner` and `rootModel` are independent.** A model can have both, pointing at different models.

### Known limitation: pull assumes ownership doesn't move away from a client

The pre-filter in pull step 1 selects changelog rows by who pushed them, not by who may see them now. Those are the same until ownership changes.

Say Alice's board is given to Bob. Every later change to that board is stored with `scopeKey: "bob"`, and Alice's pre-filter excludes those rows permanently. If Alice had already pulled her own changes before the handover, no row about that board ever reaches her `applyPull` again. The null-record delete never fires, and her local copy silently goes stale, even though she is online and polling.

- **Where it's fine:** domains where ownership never changes. The first real consumer, the MyFit app, never hands a user's workouts to another user.
- **Where it's a real gap:** domains where reassignment is normal, such as an issue tracker that moves issues between people or teams.

Systems that handle this treat permissions as a live filter, re-evaluated for each viewer on every change. Firestore sends `REMOVED` events when a document leaves a listener's authorized results. Zero treats read permissions as filters in its live query pipeline. Here, the fix would be to stop pre-filtering by the pusher's `scopeKey`: pull a bounded recent window of all changes to the client's models, and let `buildPullQueries` decide each row live for the requesting caller. An online client would then always converge, at the cost of a live check on every row in the window for every poll.

This is not implemented. It needs a different pull contract, and large systems would want a coarse partition first, such as Linear's `subscribedSyncGroups`. The current consumer can't hit the problem. A future option such as `pullStrategy: "scopeKey" | "live"` on `createSyncServer` could let consumers opt in once one needs it.

## Related

- [ADR 012](ADR%20012%20-%20Client%20Contract%20Subsetting.md): the server and client contracts.
- [ADR 013](ADR%20013%20-%20FK%20Projection%20on%20Excluded%20Models.md): which relations survive in the client contract.
- [ADR 015](ADR%20015%20-%20Contract-Derived%20Validation.md): payload validation, which runs before these checks.
- `sync-server/src/core/`: `ownership-dag.ts`, `authorization-paths.ts`, `sync-server.ts`, `changelog-schema.ts`.
- `sync-extension-idb/src/core/apply-pull.ts`: treats a `null` record as a delete.
- Prior art on permissions and revocation:
  - [Firestore query change types](https://cloud.google.com/firestore/docs/samples/firestore-listen-query-changes)
  - [Zero permissions](https://zero.rocicorp.dev/docs/permissions)
  - [Linear's sync engine, reverse-engineered](https://dev.to/wzhudev/i-reversed-linears-sync-engine-to-see-how-it-works-3cj)
  - [Kleppmann et al., Local-first software](https://martin.kleppmann.com/papers/local-first.pdf) and [Ink & Switch Keyhive](https://www.inkandswitch.com/keyhive/notebook/): in local-first systems, revocation only guarantees that an honest, still-syncing client converges.
