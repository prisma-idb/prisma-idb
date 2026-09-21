# Prisma 8 IDB Architecture Review Findings

Date: 2026-06-22

Scope: `packages/prisma-orm/*`, `apps/docs/content/docs/prisma-8`, example apps, ADRs/plans, and comparison against the local `vendor/prisma-next` SQLite/Mongo reference packages.

## Summary

The overall direction is sound: the IDB implementation now follows Prisma 8's extension model closely enough to be recognizable as a real family/target/adapter/driver/runtime stack. The strongest parts are the post-Phase-7 migration package flow, the control/runtime split, safe browser auto-migration defaults, and the typed chainable ORM surface.

The main risks are not architectural rejection-level problems. They are concentrated correctness and DX issues: create-vs-upsert semantics, referential action lookup for PSL-shaped contracts, factory injection, migration hash validation, middleware compatibility, and stale docs/metadata.

## Immediate Fixes

- `create()` must not overwrite existing primary keys.
  - Previous behavior used `store.put()` for create paths.
  - Correct behavior is `store.add()` for `create`, `createAll`, and nested create/upsert-create branches.
  - Status: fixed in working tree with driver and ORM regression tests.

- PSL-style `onDelete` must be honored from the FK side.
  - PSL stores `onDelete` on the child/FK relation, while delete enforcement previously looked only at the parent/list relation.
  - Correct behavior is to prefer a directly stored parent action for TS-authored contracts, then fall back to the inverse FK-side relation.
  - Status: fixed in working tree with a client regression test mirroring the PSL contract shape.

- `factory` override must control runtime queries, not only migrations.
  - `createAutoMigratingIdbClient({ factory })` previously used the factory during migration, then returned a client that opened global `indexedDB`.
  - Correct behavior is to thread `factory` through `createIdbClient` and `createIDBRuntimeDriver`.
  - Status: fixed in working tree with a custom-factory regression test.

- `preflight` must validate migration hashes.
  - Browser auto-migrate rejects stale/tampered `ops.json`; CI preflight should reject the same package before deploy.
  - Status: fixed in working tree with a hash mismatch regression test.

- Runtime should reject incompatible middleware.
  - SQL and Mongo reference runtimes call `checkMiddlewareCompatibility`; IDB previously accepted mismatched middleware.
  - Status: fixed in working tree with a runtime regression test.

- `openAndReadMarker()` should reject real `indexedDB.open()` failures.
  - Missing databases still open normally in IndexedDB; actual open errors should not be treated as fresh installs.
  - Status: fixed in working tree with a failing-factory regression test.

- `generate-migration` should validate the head package before planning.
  - `migration.json.to` must match `head/end-contract.json.storage.storageHash`.
  - Status: fixed in working tree with a corrupted-head regression test.

- Root README install/codegen wording should match the current docs app.
  - The old copy said "No codegen - runtime only" and installed only `family-idb`.
  - Status: fixed in working tree.

- Descriptor metadata must stay internally consistent, but upstream does not require descriptor `version` to match the npm package version.
  - Evidence: upstream `@prisma-next/driver-postgres`, `@prisma-next/target-mongo`, and `@prisma-next/adapter-mongo` package manifests report `0.14.0` while their descriptors still use `0.0.1`.
  - Status: fixed in working tree by keeping IDB descriptor versions at `0.0.1` and adding a CI/release guard that checks descriptor groups for semver shape and internal consistency.

## Remaining Findings

- TypeScript-authored contract validation is too permissive for unsupported shapes. Fail early for composite relations, missing relation fields, unsupported namespaces, duplicate store mappings, and index/key fields that do not exist.

- Relation loading currently uses only the first local/target field. This is okay only if composite relations are rejected during authoring.

- Cascades are first-hop only. Recursive cascade, `onUpdate`, and `setDefault` remain post-`0.1.x` work unless the next release wants stronger referential integrity.

- Equality queries and relation includes still scan stores even when a matching IDB index exists. This is likely the highest-value `0.2.0` performance task.

- The docs app is structurally good and type-checks, but examples that use PSL `onDelete: Cascade` depended on the FK-side fix above.

- The package graph has no one-package facade equivalent to vendor `@prisma-next/mongo` or `@prisma-next/sqlite`. Consider a small `@prisma-idb/idb` facade for config, contract authoring, runtime, and client exports.

- `target-idb/src/core/migration-driver.ts` and some schema-verify comments still reference the deleted manifest-era design. Remove or mark stale/internal to avoid misleading future extension work.

## Suggested Release Buckets

### v0.1.2

- Ship the immediate fixes above.
- Status: complete in working tree.

### v0.2.0

- Add index-backed equality lowering and relation include acceleration.
- Add recursive cascade and `onUpdate` referential actions.
- Tighten TypeScript contract validation around currently unsupported features.
- Add a facade package for end-user install/import ergonomics.
- Clarify the codec-extension story for custom IDB value codecs.
- Expand the example app to show baseline-to-follow-up migrations, fresh-IDB bootstrap, versionchange behavior, and destructive migration refusal/opt-in.
