# ADR 030: Ignored models and relations stay in the contract

- **Status:** Accepted
- **Date:** 2026-11-25
- **Area:** Contract, client, sync

PSL `@@ignore` and `@ignore` on a relation field hide the model or relation from the client, but leave it in the IDB contract. An ignored model keeps its object store, indexes, records, foreign keys and referential actions. An ignored relation keeps enforcing its foreign key and its `onDelete`/`onUpdate` actions. The contract marks them with `ignored: true` in `storage`: on the model's `storage` for an `@@ignore` model, and on the relation's `storage.relations` entry for every hidden relation. `@ignore` on a scalar field still leaves the field out of the contract.

## Why

Upstream Prisma keeps an ignored model's table and an ignored relation's foreign key. The SQL interpreter adds the foreign key, with its actions, before it skips the ignored relation ([relations.ts](https://github.com/prisma/prisma/blob/e74c6c64c7f70c29d59cca3c7e5ae4b3f6e568af/packages/2-sql-family/2-authoring/contract-prisma7/src/relations.ts#L540-L556)), and a foreign key into an `@@ignore` model points at its table by name ([relations.ts](https://github.com/prisma/prisma/blob/e74c6c64c7f70c29d59cca3c7e5ae4b3f6e568af/packages/2-sql-family/2-authoring/contract-prisma7/src/relations.ts#L215-L221)). Only the client API loses the model or relation. In SQL the database enforces the foreign key. In IndexedDB the client enforces it, and the client finds foreign keys and referential actions through domain relations ([ADR 009](ADR%20009%20-%20FK%20Validation%20and%20Referential%20Action%20Enforcement.md)). Removing an ignored relation from the domain would stop the client from enforcing it, and removing an ignored model would drop its store in the next migration. So both stay in the domain and are only hidden.

## The flags

- `storage.ignored: true` on a model's storage marks an `@@ignore` model. The model has no entry in `roots`, as upstream's ignored model has no model, so the client has no accessor for it.
- `storage.relations[name].ignored: true` marks a hidden relation. The builder sets it for a relation with its own `@ignore`, the backrelation of an `@ignore` owning relation, and every relation of or to an `@@ignore` model. Readers check this one flag.
- Ignoring only a backrelation hides only that field, as upstream does. Relations pair by name for this, and an empty name counts as no name.
- The emitted `contract.d.ts` carries both flags in each model's `storage` type, so the typed client can drop hidden relations from `include()` and nested-write types.
- `storageHash` covers only `storage.stores`, so adding or removing `@ignore` or `@@ignore` changes no store and plans no migration operation.
- TypeScript authoring writes the same flags as `ignored: true` on a model or relation definition.

## Consequences

- **Client.** An ignored model has no accessor. `include()` and nested writes refuse a hidden relation with an error that names it. Writes through visible models still check foreign keys and run cascades, `restrict`, `setNull`, `setDefault` and `onUpdate` actions through hidden relations, including into an ignored model's store.
- **Sync.** An `@@ignore` model never syncs. The browser never queues outbox events for its rows, even when `trackedModels` lists it or a cascade changes them. The sync server leaves it out of the synced models, so a push for it is an unknown model and it need not reach the root model. An `@@ignore` root model is refused when the server starts. The ownership graph comes from the server's contract, the SQL contract for a SQL server. The pinned SQL family keeps `@ignore` owning relations and `@@ignore` models there, so an `@ignore` owning relation stays an ownership path.
- **Restrictions.** A relation that joins on an `@ignore` scalar field is refused with `IDB_IGNORED_FIELD_REFERENCED` even when the relation is `@ignore`, because the relation still enforces its foreign key and needs the field. Upstream accepts this, because the column stays in the SQL table. A singular backrelation that is `@ignore`, or whose owning relation is, is left out, because this contract has no singular backrelation to keep. An `@@ignore` model still needs a primary key, because its object store needs a key path; without one it fails with `IDB_MISSING_ID`, whose message says so. Upstream accepts an `@@ignore` model without a key, because a SQL table needs none. The other model checks, such as field types and indexes, apply to an ignored model as to any other, for the same reason.

## Alternatives considered

- **Remove ignored models and relations from the contract.** This was the first behavior. It drops the store of a model that gains `@@ignore`, and it stops foreign-key checks and cascades through an ignored relation, so the browser and the server disagree about what a delete does.
- **A storage-level foreign-key list without domain relations, like upstream's storage foreign keys.** Closer to upstream's structure, but every enforcement path in the client would have to read a second source, and an ignored model would need a store with no model. The flag reuses the enforcement that already exists.
