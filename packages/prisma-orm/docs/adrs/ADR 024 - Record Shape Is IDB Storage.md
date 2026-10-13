# ADR 024: Record shape is IDB storage

- **Status:** Accepted.
- **Date:** 2026-10-11
- **Area:** Contracts and migrations

## Context

IndexedDB object stores have no column definitions. Our storage hash previously covered stores and indexes only. Adding `migrationError String?` changed the client contract without changing its storage hash. The planner, migration chain, runtime marker, and sync contract check could not detect that change.

Stored records still have a shape. The client needs to know which fields, types, and enum values it can read. Treat that shape as storage, even when IndexedDB needs no structural operation.

## Decision

### 1. Include record shape in storage

Each model store includes `record` metadata in `contract.storage.stores`. It records the model and stored fields, including types, codecs, nullability, list and dictionary cardinality, enum values, and nested value objects. Canonical hashing includes this metadata in `storageHash`.

A stored field change moves `storageHash`. A change outside the storage projection does not. Defaults belong to execution metadata; changing only a default does not move the storage hash. Capability settings remain part of `profileHash`.

This follows the storage/profile boundary in upstream [ADR 004](https://github.com/prisma/orm/blob/6e12cc2/docs/architecture%20docs/adrs/ADR%20004%20-%20Storage%20Hash%20vs%20Profile%20Hash.md). Upstream [ADR 187](https://github.com/prisma/orm/blob/6e12cc2/docs/architecture%20docs/adrs/ADR%20187%20-%20MongoDB%20schema%20representation%20for%20migration%20diffing.md) provides the MongoDB precedent for representing storage in a migration schema model.

### 2. Use one storage hash

`storageHash` replaces the unreleased `contractFingerprint`. Migration endpoints, snapshots, contract-space heads, runtime markers, and the sync contract check use the same storage identity. Sync compares the emitted **client** contract's storage hash on both sides.

Migration packages still identify their operations separately. This preserves upstream [ADR 199](https://github.com/prisma/orm/blob/6e12cc2/docs/architecture%20docs/adrs/ADR%20199%20-%20Storage-only%20migration%20identity.md): migration identity concerns storage and operations, not unrelated contract metadata.

### 3. Read absent nullable fields as null

When the ORM reads an old record, it returns `null` for a missing nullable field. This also applies inside value objects, lists, and dictionaries. Union fields are unsupported and rejected before records are read. It does not write a value back to IndexedDB.

Adding a nullable field therefore needs a migration that advances the hash and marker, but no record rewrite. The planner writes an empty operations list when nothing else changes.

`validateRecord` stays strict. Wire records must still include nullable fields explicitly as `null`. The read rule does not relax [ADR 015](ADR%20015%20-%20Contract-Derived%20Validation.md).

### 4. Plan known backfills and expose unknown ones

For an existing store, the planner emits `transformRecordsOp` with:

- `defaultIfMissing` for a new required scalar field with a supported literal default.
- `removeFields` for removed fields.
- `placeholder("Model.field")` for a required addition without a supported literal default, or an incompatible change to an existing field.

Nullable additions and compatible widening changes need no rewrite. New stores have no old rows to backfill. Legacy snapshots without record metadata provide no field history to compare.

The planner writes an editable scaffold with unresolved slots. Authors fill those slots, then regenerate the package. Package emission, preflight, and runtime application reject unresolved placeholders with `MIGRATION.UNFILLED_PLACEHOLDER`, including ones nested in `pipe`. Validation throws one framework `CliStructuredError` with all distinct slot names in its `why` and `meta.slot`. The IDB placeholder is a JSON sentinel, rather than upstream's throwing function, so the planner can persist an editable scaffold. Both follow the fail-closed authoring rule in upstream [ADR 200](https://github.com/prisma/orm/blob/6e12cc2/docs/architecture%20docs/adrs/ADR%20200%20-%20Placeholder%20utility%20for%20scaffolded%20migration%20slots.md).

[ADR 016](ADR%20016%20-%20Declarative%20Record%20Transforms%20in%20IDB%20Migrations.md) defines the transform vocabulary. [ADR 023](ADR%20023%20-%20Migrations%20Rewrite%20Pending%20Outbox%20Payloads.md) defines its use for queued sync edits.

### 5. Never infer a rename

A removed field and an added field remain separate changes. The planner cannot know whether they represent a rename. Authors preserve values with `transformRecordsOp(store, { renameFields: { newName: "oldName" } })`. They remove the corresponding planned removal and backfill or placeholder.

This follows the explicit rename rule in upstream [ADR 264](https://github.com/prisma/orm/blob/6e12cc2/docs/architecture%20docs/adrs/ADR%20264%20-%20A%20model%20names%20its%20storage%20verbatim,%20and%20a%20rename%20is%20an%20operation.md). IDB key fields remain immutable under [ADR 020](ADR%20020%20-%20Primary%20Keys%20Are%20Immutable.md).

## Rejected alternatives

- **Keep record shape outside storage:** field changes would remain invisible to migrations and markers.
- **Keep a separate contract fingerprint:** two compatibility identities would need independent checks and could drift.
- **Rewrite every nullable addition to null:** the read rule provides the same result without walking every old record.
- **Guess defaults or conversions:** plausible values could hide data loss; unresolved slots require an author decision.
- **Guess renames from similar fields:** similarity does not establish intent or justify preserving values under another name.

## Consequences

Field-only changes now require a migration, even when its operations list is empty. Preflight rejects an emitted contract that differs from the chain head. Runtime opening checks that each contract-space head matches its bundled contract, then advances the marker through pending migrations.

After a server deploys a new client storage hash, sync requests from an old bundle receive HTTP 409. The worker preserves queued edits and the pull cursor. Reloading the new bundle applies its migrations before sync resumes.

For the author workflow, see [Author a field change](../../../../apps/docs/content/docs/prisma-8/field-changes.mdx).
