# ADR 025: Scalar lists

- **Status:** Accepted.
- **Date:** 2026-10-18
- **Area:** Contracts, mutations, and migrations

Scalar and enum lists use native IndexedDB arrays. Each element uses the field's scalar codec. Supported scalars are String, Int, BigInt, Float, Decimal, Boolean, DateTime, Bytes, and Json. Lists and their elements are required. A declared empty-list default makes the create input optional; nonempty list defaults remain unsupported.

Missing lists are not read as empty arrays. This follows [ADR 024](ADR%20024%20-%20Record%20Shape%20Is%20IDB%20Storage.md) and the [Prisma 8 Mongo decoder](https://github.com/prisma/orm/blob/34f77c24695e5b6154d8d0721dd80f985cbbc186/packages/2-mongo-family/7-runtime/src/codecs/decoding.ts). Adding a required list changes storage identity. The planner emits `defaultIfMissing([])` when the field declares that default, or a placeholder that the author must resolve. Only applying the migration repairs existing rows. Pending creates receive the same backfill; sparse update patches stay sparse, as [ADR 023](ADR%20023%20-%20Migrations%20Rewrite%20Pending%20Outbox%20Payloads.md) requires.

The fluent mutation surface follows the pinned [Prisma 8 field accessor](https://github.com/prisma/orm/blob/34f77c24695e5b6154d8d0721dd80f985cbbc186/packages/2-mongo-family/5-query-builders/orm/src/field-accessor.ts): `set`, single-element `push`, `pull`, `addToSet`, and `pop`. These operations share the existing mutation transaction and record the resulting array in the outbox. `unset` is rejected for required lists, preserving strict record validation. JSON `pull` matches complete elements by structural equality; partial-object matching is not added.

The pinned Mongo [filter AST](https://github.com/prisma/orm/blob/34f77c24695e5b6154d8d0721dd80f985cbbc186/packages/2-mongo-family/4-query/query-ast/src/filter-expressions.ts) defines equality, ordering, and membership predicates. The old stable client's `has`, `hasEvery`, `hasSome`, and `isEmpty` surface is not part of this API. The pinned [collection](https://github.com/prisma/orm/blob/34f77c24695e5b6154d8d0721dd80f985cbbc186/packages/2-mongo-family/5-query-builders/orm/src/collection.ts) permits ordering on model fields, including lists. IDB compares lists lexicographically by element, with numeric Decimal comparison and structural JSON comparison. List queries scan; this change creates no indexes or `multiEntry` indexes.

Contract validation rejects list fields in primary keys (`IDB_LIST_ID`) and indexes (`IDB_LIST_INDEX`) because list queries scan and `multiEntry` indexes would change filter results.

Silently interpreting missing lists as `[]` would hide unmigrated records and change query results. Explicit migration keeps stored data, filters, and sync payloads consistent. On migrated stores, every included required list is an array. Projection removes fields without synthesizing values.
