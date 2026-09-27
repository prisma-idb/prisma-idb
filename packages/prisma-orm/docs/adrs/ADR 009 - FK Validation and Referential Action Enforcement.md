# ADR 009: Foreign keys and referential actions

- **Status:** Accepted
- **Date:** 2026-06-05
- **Area:** ORM

## Summary

IndexedDB has no foreign-key constraints, so the client enforces them itself:

- **Every write that sets a foreign key checks that the parent exists.**
- **Every delete and update runs the relation's referential action** (`cascade`, `setNull`, `setDefault`, `restrict` or `noAction`), in the same transaction.

The actions are stored in the IndexedDB target's own storage metadata, not in the framework's shared relation type. Both actions default to `restrict`, and `noAction` behaves like `restrict`. Postgres's default for the same Prisma 8 schema is `NO ACTION`, which rejects the same changes, so a synced app's client and server allow the same changes.

## Context

IndexedDB stores records by key and has no concept of a foreign key. Nothing stops a record from pointing at a parent that doesn't exist, and there is no `ON DELETE CASCADE`. MongoDB is in the same position. SQL targets avoid the problem by generating `ON DELETE …` clauses and letting the database enforce them.

The framework's relation type, `ContractReferenceRelation`, only describes the join: `to`, `cardinality` and `on: { localFields, targetFields }`. It has no `onDelete` or `onUpdate`. That's deliberate: referential actions belong to the storage layer. SQL keeps them in its own storage metadata (`SqlModelStorage`), and IndexedDB needs an equivalent.

Before this decision there were two gaps:

1. **Plain foreign-key writes weren't checked.** `db.posts.create({ userId: "nonexistent" })` succeeded and left a dangling reference. Only nested `connect()` checked that the parent existed.
2. **`delete()` ignored relations.** Deleting a parent left its children pointing at a record that no longer existed.

## Decision

### 1. Store referential actions in `IdbModelStorage`

```ts
export type IdbReferentialAction = "cascade" | "setNull" | "setDefault" | "restrict" | "noAction";

export type IdbRelationStorage = {
  readonly onDelete?: IdbReferentialAction; // default: "restrict"
  readonly onUpdate?: IdbReferentialAction; // default: "restrict"
};

export type IdbModelStorage = {
  readonly storeName: string;
  readonly keyPath: IdbKeyPath;
  readonly relations?: Record<string, IdbRelationStorage>; // keyed by relation name
  readonly fieldDefaults?: Record<string, string | number | boolean>; // for setDefault
};
```

These types live in `target-idb/src/core/idb-contract-types.ts`. You set the actions with `@relation(onDelete: ..., onUpdate: ...)` in a Prisma schema, or `onDelete`/`onUpdate` on a relation in the TypeScript contract builder.

### 2. Check foreign keys on every write

When `create()`, `createAll()`, `update()`, `updateAll()` or either branch of `upsert()` sets a foreign key, the client checks, inside the write's transaction, that the referenced parent exists. If it doesn't, the transaction aborts with an error naming the relation and the missing values. Nested writes are checked the same way: the row being written and every row a relation callback creates.

- **The check sees the row as it's written, after defaults.** A foreign key filled in by `@default(...)`, or by an `onUpdate` default, is checked like one the caller set.

- **A compound foreign key is checked as one tuple.** A single parent row must match every field. Checking the fields one at a time could pass with each value taken from a different parent. When an update sets only some fields of a compound key, the client reads the row first and takes the other fields from it.
- **A key with any `null` field isn't checked**, like SQL's default `MATCH SIMPLE`.
- **A reference to the parent's primary key is a key-only lookup**, even for a compound primary key. It never loads the parent record. Other references scan the parent store. Both compare values the way IndexedDB compares keys, so two equal `Date` values match even though they are different objects. See [ADR 017](ADR%20017%20-%20Native%20IndexedDB%20Feature%20Parity.md).

Writes that don't touch any foreign key take the ordinary write path, with no extra reads.

### 3. Run referential actions on deletes and updates

When a record is deleted, the client finds every relation whose children point at it and applies that relation's `onDelete`:

| Action               | What happens to the children                                              |
| -------------------- | ------------------------------------------------------------------------- |
| `cascade`            | They are deleted too.                                                     |
| `setNull`            | Their foreign-key fields are set to `null`.                               |
| `setDefault`         | Their foreign-key fields are set to the field's declared `@default(...)`. |
| `restrict` (default) | The delete fails if any children exist.                                   |
| `noAction`           | Same as `restrict`.                                                       |

The same happens on `update()`, including a nested update, using `onUpdate`, when the update changes a value that children refer to. The client compares the old and new values, so including an unchanged field in the patch doesn't trigger anything. The default `onUpdate` is `restrict`. Declare `onUpdate: Cascade` to copy the new value to the children instead.

### Why the defaults match Postgres, not Prisma 7

Prisma 7 defaulted `onUpdate` to `cascade`, and `onDelete` to `setNull` for optional relations. Prisma 8 emits no `ON DELETE` or `ON UPDATE` clause for an action you don't declare, so Postgres uses `NO ACTION`, which rejects the change. SQL's `NO ACTION` differs from `RESTRICT` only in when it checks: at the end of the statement rather than immediately.

A syncing app builds its client and server contracts from one schema ([ADR 012](ADR%20012%20-%20Client%20Contract%20Subsetting.md)). If the client cascaded where the server refused, a local change would succeed, then fail on push, and the two sides would disagree for good. Refusing on the client makes the problem visible when the user makes the change.

Each action runs inside one `withMutationScope` transaction that covers the parent's store and every store the action could touch. The store list is worked out from the contract before the transaction opens, as IndexedDB requires ([ADR 007](ADR%20007%20-%20Two%20Transaction%20APIs.md)).

## Why `IdbModelStorage`, not `ContractReferenceRelation`

`ContractReferenceRelation` belongs to the framework and is shared by every database family. Adding `onDelete` to it would mean either pushing a storage concern into the framework, or forking the type. Neither is right.

`IdbModelStorage` is the IndexedDB target's own description of its storage. It already holds IndexedDB-only fields such as `storeName` and `keyPath`. Referential actions fit there, the same way SQL keeps them in `SqlModelStorage`.

## Consequences

- **Deletes and key changes are safe by default.** With the default `restrict`, a change that would leave dangling children throws. You opt in to `cascade`, `setNull` or `setDefault`.
- **There is no way to turn enforcement off** for a relation. Postgres has none either. An earlier version treated `noAction` as "don't enforce", which let the client delete rows the server would refuse to.
- **`deleteAll()`, `deleteCount()`, `updateAll()` and `updateCount()`** apply the actions row by row, inside the same transaction.
- **Foreign-key checks cost one read per relation per write**, and only when the write sets a foreign key. For a primary-key reference, that read fetches only the key.
- **Cascades follow the whole chain.** For `User → Post → Comment`, deleting a user deletes its posts and their comments. Each child is read, its own relations are handled, then it is deleted. The walk is cycle-safe, so self-referencing or mutually cascading models don't loop. `setNull` and `setDefault` stop the walk, because the child survives.
- **Cascaded deletes are tracked one row at a time.** Because each child is read and deleted individually, sync records one outbox write per cascaded row, not one for the whole batch.
- **`setDefault` needs a literal default.** `IdbModelStorage.fieldDefaults` only holds literal `@default(...)` values, never generators such as `uuid()` or `now()`. Prisma has the same restriction. If a child's foreign-key field has no default, `setDefault` throws.
- **`setDefault` checks the default too.** Before writing it, the client checks that a parent with that value exists, matching every field of a compound relation. Without this, `setDefault` could itself create a dangling reference, for example setting `authorId` to `"system"` when no `"system"` user exists. A real database gets this for free, because its foreign-key constraint re-checks the new value.
- **`upsert()` needs a transaction-capable executor**, like `update()`, `updateAll()` and `deleteAll()`. `create()` and `delete()` only need one when the write actually involves relations or foreign keys.
- **`createAll()` with foreign keys runs in one transaction**, checking and inserting each row in turn. If one row fails, none are written.

## Related

- `target-idb/src/core/idb-contract-types.ts`: `IdbModelStorage`, `IdbRelationStorage`, `IdbReferentialAction`.
- `family-idb/src/core/contract-builder.ts` and `psl-interpreter.ts`: where `onDelete`/`onUpdate` are read from the schema.
- `client-idb/src/core/mutation-executor.ts`: `validateScalarFks`, `parentExists`, `enforcedAction`, `applyReferentialActionsForRow`, `applyReferentialActionsForRowOnUpdate`, `validateSetDefaultPatch`.
