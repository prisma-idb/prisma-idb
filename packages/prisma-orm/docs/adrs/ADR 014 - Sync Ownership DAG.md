# ADR 014: Sync ownership graph

- **Status:** Accepted, with a known limitation (see Consequences)
- **Date:** 2026-08-09
- **Area:** Sync (server side)

## Summary

Creates and updates must keep every populated tenant parent in the caller's scope.
Existing-row access, pull and delete require only one matching path to that scope.

The sync server follows relations from each record to a root model, such as `User`.
These paths form the ownership graph. The server builds it from the contract at startup.

`@prisma-idb/sync-server` describes the checks and queries. The app executes them against its database.
The package runs only on the server.

### Terms

| Term          | Meaning                                                                                  |
| ------------- | ---------------------------------------------------------------------------------------- |
| Scope         | The caller's root record, such as Alice's `User` row. `scopeKey` identifies this record. |
| Tenant parent | A row referenced by an outgoing foreign key whose relation has a path to the root model. |
| Candidate row | The proposed row: the create payload, or the stored row merged with an update patch.     |

## Context

The outbox in `sync-extension-idb` makes local writes durable and retryable. It says nothing about whether the client is allowed to make them. A buggy or malicious client can put anything in its outbox, for example an update to someone else's comment. Without a check, the server would apply it. Pull has the matching problem: it must return only the rows this client may see, not every row that exists.

The old generator (`packages/generator`) solved both with one mechanism:

- A `rootModel`, such as `User`, set in the generator config.
- An ownership graph built from every model's relations back to that root.
- For each model, every path back to the root, not just the shortest one.

Existing-row access and pull accepted any matching ownership path. The later generator also checked every populated path in write payloads.
Commit `5ffaa780` added this check as `emitMultiPathPayloadOwnershipCheck`.
The SQL adapter now preserves that distinction between access and writes. Each tenant parent can use any of its paths to the root.

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

The app must authorize the candidate row and every populated tenant parent before a create or update.
A matching path through one tenant parent cannot authorize another tenant parent outside the caller's scope.

For each outbox event, the server and adapter follow this sequence:

1. Reject models outside `clientContract` as `unknown-model`.
2. Validate the payload against the client contract, as described in [ADR 015](ADR%20015%20-%20Contract-Derived%20Validation.md).
3. Find every path from the event's model to the root.
4. For updates and deletes, authorize the stored row through any path to the caller's scope.
5. For creates and updates, build the candidate row. Merge the stored row with the update patch, retaining omitted foreign keys.
6. Require at least one candidate row path to the caller's scope.
7. Check every populated tenant parent. Each parent must reach the caller's scope through at least one of its paths.
8. Reject resolved violations with non-retryable `SCOPE_VIOLATION`, before writing the record or changelog entry.

Null optional tenant parents need no check. A populated foreign key that references a missing tenant parent fails.

The adapter must run the authorization checks, record write and changelog write in one transaction.
Otherwise, a concurrent ownership change could invalidate the checks before the write.
`sync-server` describes the checks but cannot enforce the transaction because it never accesses the database.

#### Example: Alice's FoodEntry

Alice creates a `FoodEntry` with `userId: "alice"` and `mealId` pointing to Bob's `Meal`.
Its direct `User` path reaches Alice, but its tenant parent check fails.
The SQL adapter returns `SCOPE_VIOLATION` and writes neither the record nor the changelog entry.
The same rule applies if `recipeId` points to Bob's `Recipe`.

### Pull

For the root model, the row's own key must equal `scopeKey`.
For other models, `buildPullQueries` requires any one path to the caller's scope. It does not apply candidate row or tenant parent checks.

Pull has two steps, as in the old generator. `buildPullQueries` is only the second:

1. **Pre-filter the changelog.** When a push is accepted, the app stores its `scopeKey` on the changelog row. On pull, it first selects only rows with the caller's `scopeKey`. `SyncPullLogEntry` deliberately has no `scopeKey` field. Storing it and filtering on it is the app's job.
2. **Re-check ownership live.** For each remaining row, run the check from `buildPullQueries` against current data.

The live re-check is needed because ownership can change after the push. For example, Alice creates a todo on her board, and the changelog row is stored with `scopeKey: "alice"`. The board is then given to Bob. Alice's next pull still matches the stored `scopeKey`, but the live check now leads to Bob, so Alice's query finds nothing. Without step 2, Alice would still receive the todo.

When a record fails the live check, the server sends it with `record: null`. On the client, `applyPull` treats a `null` record as a delete, including cascades, rather than skipping it. A record the client may no longer see has to disappear locally.

### Why access accepts any matching path

A record can belong to the caller's scope through more than one relation.
Requiring every path would reject records that belong to the caller through only one relation.
Checking only the shortest path would fail when that path has a null foreign key but a longer path still matches.

The same reasoning applies to alternate paths through a single tenant parent.
It does not apply across different tenant parents: each populated tenant parent must belong to the caller's scope.

### Tenant parent check boundaries

- Checks include server-only tenant parents.
- Checks exclude inverse collections and global parents with no path to the root.
- Checked relations must use a single-field foreign key to the tenant parent's primary key.
- The SQL adapter rejects defaults on checked foreign keys because authorization requires their resolved values before insertion.

### Adding the `Changelog` model to the server schema

The `Changelog` table has to live in the server's database, never in IndexedDB. The old generator made developers type `Changelog` and `ChangeOperation` into `schema.prisma` by hand, and then validated them field by field.

Instead, `@prisma-idb/sync-server/schema` exports `sqlContractWithSync`. It takes the same `schema.prisma` the browser client uses and, in memory, before the SQL family parses it:

1. **Removes the `idb` attributes** (`stripIdbExcludeAttributes`). They mean nothing to the server, and the SQL parser rejects the unknown namespace.
2. **Adds a SQL `Changelog` model** (`injectChangelogModelSql`), with a real enum and a UUID v7 id (`@default(uuid(7))`, generated by the ORM when the row is inserted). The id is a string that sorts correctly as text, so the pull cursor stays an opaque string and never needs numeric comparison. It reflects insert order, not commit order, so it does not close the concurrent-push gap on its own.

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

### Historical rows

Historical rows with tenant parents in different scopes remain readable or deletable through any matching path.
An update that retains a tenant parent outside the caller's scope fails.
A complete repair to the caller's scope may pass. No single relation determines who may repair the row.

The new checks do not clean up historical data or propagate ownership transfers to inverse children.
They also do not validate writes outside sync.
Non-retryable push rejections reconcile under ordinary pull authorization, as described in [ADR 022](ADR%20022%20-%20Rejected%20Pushes%20Reconcile%20to%20the%20Server%20Row.md).

### Upgrade impact

- Upgrading the server and SQL adapter tightens create and update acceptance by default.
- No relation policy configuration is required.
- Checked foreign keys cannot have database or ORM-generated defaults. Callers must supply those values explicitly.

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

- `sync-server-sql/src/core/apply-push.ts` and `pull.ts`: route orchestration through the ownership checks.
- `sync-server-sql/src/core/authorization.ts`: executes ownership paths against the SQL client.
