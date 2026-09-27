# ADR 013: Relations to excluded models

- **Status:** Accepted
- **Date:** 2026-08-08
- **Area:** Contract authoring

## Summary

When a model is excluded from the client contract ([ADR 012](ADR%20012%20-%20Client%20Contract%20Subsetting.md)), any relation that points at it is dropped from the models that remain, and a warning names each dropped relation. The foreign-key field itself stays on the model, exactly as declared. A model is never excluded just because it has a relation to an excluded model, even a required one.

## Context

With ADR 012, a model can be excluded from the client contract. A model that stays can still have a relation pointing at one that was excluded. For example, `Comment.post` may point at an excluded `Post`. The client can't represent that relation, because the `posts` store doesn't exist in its IndexedDB database.

The contract keeps relations and foreign-key fields separately:

- `model.relations` holds each relation's cardinality and join fields (`on.localFields`, `on.targetFields`).
- The foreign-key values are ordinary scalar fields in `model.fields`, for example `authorId: String`.

## Decision

After ADR 012 has worked out which models are excluded, the client projection does the following:

1. **The excluded set is exactly the models marked `@@idb.exclude`.** Nothing is added to it. A model is never excluded because of its relations.
2. **Every relation that points at an excluded model is dropped** from the surviving models. This applies to every cardinality, and to required and optional relations alike.
3. **The foreign-key field is kept**, with its original type and nullability. It is still a valid value, just no longer checked or followed locally, because the client has no parent store to check it against ([ADR 009](ADR%20009%20-%20FK%20Validation%20and%20Referential%20Action%20Enforcement.md)). The server, which has the full relation, still enforces it.
4. **A warning names every dropped relation**, so developers can see why a relation disappeared from the client contract.

Because excluding a model never causes another exclusion, there is nothing to repeat until a fixed point is reached.

## Why a required relation doesn't exclude the child

The old generator (`packages/generator`) did exclude a model if it had a required relation to an excluded one, repeating until nothing changed. An early draft of this ADR copied that rule. It is wrong here, because "excluded" means something different.

In the old generator, a model was excluded because it could not be an IndexedDB store at all, for example because its key type isn't a valid IndexedDB key. A required relation to a model that can't exist is arguably impossible too.

`@@idb.exclude` is a choice to keep a model on the server. Nothing about the model is incompatible with IndexedDB. And:

- **IndexedDB never enforces foreign keys itself.** All checks happen in the client ([ADR 009](ADR%20009%20-%20FK%20Validation%20and%20Referential%20Action%20Enforcement.md)). A required foreign-key field means "a value must be present", not "a matching row must exist locally". Keeping the field and dropping the relation still meets that.
- **A model's own key never comes from its foreign keys.** Even a compound primary key is declared explicitly with `@@id`, not derived from a relation. So the child's identity never depends on the excluded parent being present.

So there is no reason for the child to become unrepresentable, whether the relation is required or optional.

## Why keep the foreign-key field

Removing it would silently change the shape of records the client has already synced, on every later pull. That's a breaking change nobody would notice. Keeping it as a plain value costs nothing, and a client write that includes the field still makes sense to the server, which has the full relation.

## Consequences

- **Exclusion never spreads.** A model is excluded only if it is marked. The only surprise is a relation disappearing from a model that is still there, and the warning covers that.
- **Field-level `@idb.exclude` never excludes a model.** Only `@@idb.exclude` does, and it only removes relations that point at the excluded model.
- **This happens once, when the contract is emitted.** Nothing runs in the browser.
- **A required foreign-key field can hold a value that never matches a local row.** This follows from choosing to exclude the parent in the first place.
- **Sync still needs a root model.** [ADR 014](ADR%20014%20-%20Sync%20Ownership%20DAG.md) requires every synced model to reach a root model, such as `User`, through relations, and it checks this against the models that survive projection. If the root model itself is excluded, `createSyncServer` throws when it is created.

## Related

- `family-idb/src/core/psl-interpreter.ts` and `contract-builder.ts`: the relation-dropping projection. `warnDroppedRelation` in `psl-interpreter.ts` is the shared warning.
- `sync-server/src/core/ownership-dag.ts`: the root-model check.
