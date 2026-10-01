# ADR 015: Validation derived from the contract

- **Status:** Accepted. Implemented.
- **Date:** 2026-08-13
- **Area:** Sync

## Summary

Validate synced records using arktype validators derived from the contract at runtime. Push shape checks precede ownership checks. Pulled records are decoded and validated before opening the write transaction. No validator code is generated.

## Context

`decodeJsonRecord` converts wire values into native values but does not check missing fields, incorrect types, enums or extra fields. Before this decision, malformed push events reached ownership and database work, while malformed pulls could write corrupt records or disappear into the catch-all skip count.

## Decision

### Runtime validators and strict records

`target-idb/runtime` exports `validateRecord(contract, modelName, record): ValidationResult`, `validateKeyFields` for key-only records and `validateKeyPath` for IndexedDB key values (including compound keys). Results are `{ ok: true }` or `{ ok: false, issues: string[] }`; validation does not mutate input.

Validators are cached by contract identity, codec lookup identity, model and validation mode. Contracts and codec lookups must remain immutable during use. Separate contract instances cannot share a model's validator accidentally.

Each field derives its native application type from codec metadata. All `idb/*` codecs are covered, including `Date`, `bigint` and `Uint8Array`. Dates must be valid, numbers finite, and `idb/int32@1` values integral and within int32 bounds. Enums use their declared member **values**, including mapped values, rather than member names. Value objects, unions and dictionaries also derive their shape from the domain. Unsupported codecs or value-set references fail closed with validation issues.

**Extra fields are rejected**, including in nested value objects and partial patches. Nothing is stripped silently. Full records require every declared field, including nullable fields: nullability permits `null`, not a missing field. List and dictionary containers are built from the scalar validator, then nullability is applied to the container; their elements do not become nullable. This follows the contract's field-level nullability.

A required JSON scalar (`idb/json@1`, `pg/json@1` or `pg/jsonb@1`) accepts JSON `null`, while still requiring the field and rejecting `undefined`. JSON null is a value, independent of database NULL; this corresponds to [Prisma's `JsonNull` distinction](https://www.prisma.io/docs/orm/v7/prisma-client/special-fields-and-types/working-with-json-fields#using-null-values). Sync carries the JSON value itself, not Prisma Client's null sentinel objects. Non-nullable list/dictionary containers still reject `null`.

### Shared implementation, server contract

The implementation stays in `target-idb` next to `decodeJsonRecord`, and `sync-server` adds a runtime dependency on its browser-safe runtime export. The record builder itself only needs the framework's `ContractWithDomain`, not IndexedDB storage. Its optional codec lookup supplies native application types from another family.

`sync-server` validates against the **server contract**, never the client-projected contract. Its default lookup covers IDB and the common SQL/Postgres codecs using explicit codec-id-to-application-type mappings (SQL `targetTypes` describe database types, not JavaScript values); other families can supply `CreateSyncServerOptions.codecLookup`. Unsupported application representations require an appropriate codec mapping rather than falling back to unchecked data. Ownership and key resolution retain their existing family-neutral interfaces and single-key sync limitation. Compound-key validation is supported by the target helpers; compound-key ownership is not added by this ADR.

### Push validation

`validatePush` validates keys first, then records, and only then resolves ownership paths. `PushValidationResult.check` can now be `{ kind: "validation-failure", error, issues }`, where `error` is `KEYPATH_VALIDATION_FAILURE` or `RECORD_VALIDATION_FAILURE`. Unknown or client-excluded models retain their existing unknown-model result.

Creates validate full input, allowing omitted nullable fields because the server ORM fills them with null. Updates validate supplied patch fields; absent fields remain unchanged. Deletes validate only the key. The standalone `validateRecord` default remains strict for complete synced records.

The SQL batch adapter includes update patches in validation and revives JSON date, bigint and bytes values before calling `validatePush`. It returns non-retryable validation error codes without opening an ownership/write transaction. Updates cannot reassign the primary key through a patch. The pre-revival payload is retained as `SyncPushEvent.wirePayload`: ownership checks and changelog `keyPath` use its wire key, while native values are validated and used for ORM queries. Root scope comparisons use wire keys too. SQL BigInt keys can round-trip to an IDB string-key projection; native bigint IndexedDB primary keys remain unsupported.

Its lower-level `applyPushEvent` also accepts and short-circuits validation-failure checks.

### Pull validation and reporting

`applyPull` decodes each record and key, validates them and checks that the record's primary key matches the changelog key before opening the write transaction. Decode failures, invalid keys and invalid records skip the row without throwing. A null record still means an ownership revocation and applies as a delete; an explicit delete does not validate an unused record.

`ApplyPullResult` and the worker's `pullcompleted` event expose `validationFailed`, a subset of the total `skipped` count. Callers can distinguish corrupt server data from stale rows, pending local changes and transaction failures without losing the aggregate count.

The returned `lastChangelogId` is the highest applied **or validation-failed** id. A corrupt final row, or a wholly corrupt batch, therefore advances the transport cursor and its existing persistence hook. IDs retain the server's lexicographic UUID v7 ordering. Per-record version metadata advances only on successful writes. Other skip reasons retain their existing cursor behavior. A transaction failure does not itself advance the cursor, but the maximum applied or validation-failed id can pass an earlier failed row in the same batch. This pre-existing behavior is unchanged; failed rows are not guaranteed to be retried.

### Why arktype

The framework already uses arktype for codec schemas. Runtime derivation avoids generated validators drifting from their contract and adds no second validation library. The validators are reused across a long-lived server process or browser session.

## Consequences

- Extra fields and enum values unknown to an older client are now rejected. A rejected pull is reported and consumed; clients need an updated contract to accept newer server shapes.
- Public push consumers must handle `validation-failure` before executing ownership checks. SQL adapter consumers receive the two codes as non-retryable event errors.
- Native values are validated after decoding. Raw ISO strings, bigint strings and base64 strings are not valid native records.
- Record validation checks shape, not relational integrity or permission. Ownership checks and database constraints remain necessary after validation.
- Adding codecs with a new native application representation requires extending the scalar mapping. Built-in mapping coverage and push/pull integration are tested.

## Related

- [ADR 014](ADR%20014%20-%20Sync%20Ownership%20DAG.md): push authorization follows shape validation.
- [ADR 012](ADR%20012%20-%20Client%20Contract%20Subsetting.md): each side validates its own contract.
- `target-idb/src/core/validate-record.ts`: cached validators.
- `target-idb/src/core/decode-json-record.ts`: wire-to-native conversion.
- `sync-server/src/core/sync-server.ts`: pre-ownership push checks.
- `sync-extension-idb/src/core/apply-pull.ts`: pull validation and counters.
