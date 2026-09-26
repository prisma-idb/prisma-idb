# ADR 001: IDB version integer as migration identity

- **Status:** Superseded
- **Date:** 2026-05-24
- **Area:** Migrations

> **Superseded.** The manifest file described below no longer exists, and the version number no longer identifies a migration. The browser now reads the database's current version and opens it at `db.version + 1` whenever there are migrations to apply. It works out which migrations are pending from the contract hash in the marker store, by walking the migration chain from that hash. The version number is only the trigger IndexedDB requires to allow schema changes.
>
> The core idea still holds: IndexedDB needs an integer to trigger schema changes, and the marker's hash is what says which schema the database actually has.

## Context

The upstream framework models migrations as edges between contract hashes (upstream ADR 001, Migrations as Edges). Each migration goes from a `from` hash to a `to` hash. The runner refuses to apply a migration unless the database's marker matches `from`.

IndexedDB can't use a hash to trigger a schema change. Schema changes are only allowed in the `upgradeneeded` callback, and the browser only fires it when you call `indexedDB.open(name, version)` with a version higher than the stored one. The integer version is the only way in.

## Decision

Use two separate mechanisms that together do what the upstream edge model does:

- **The version integer triggers schema changes.** A manifest file stored `idbVersion`. Before each migration, the caller computed `targetVersion = (manifest.idbVersion ?? 0) + 1` and opened the database at that version.
- **The `storageHash` in the marker store checks the result.** After the schema changes succeed, the migration runner writes the contract's `storageHash` to the `_prisma_next_marker` store. At runtime, `verifyMarker()` compares it with the contract's hash.

| Mechanism                   | What it guarantees                                                          |
| --------------------------- | --------------------------------------------------------------------------- |
| Version integer             | Schema changes run in order. IndexedDB never lets the version go backwards. |
| `storageHash` in the marker | The schema that was applied is the one the contract expects.                |
| `verifyMarker()` at runtime | No queries run until a matching migration has been applied.                 |

If something outside the migration runner raises the version, the marker isn't updated. `verifyMarker()` then returns `false` and queries are blocked. This failure is safe and easy to detect.

## Alternatives considered

- **The full hash-edge model.** Storing `from` and `to` hashes and checking them before opening would need an extra connection to read the marker before deciding whether to trigger an upgrade, with no enforcement from the browser. The integer plus the hash covers the same safety properties using what IndexedDB provides.
- **The full upstream marker.** Upstream ADR 021 (Contract Marker Storage) includes fields for auditing and multiple contract spaces, such as `invariants`, `contract_json`, `canonical_version` and `app_tag`. At the time, IndexedDB had no extensions and no multi-tenant schemas, so a minimal marker (`storageHash`, `profileHash`, `updatedAt`) was enough. The marker has since grown the upstream fields and is keyed by contract space. See [ADR 010](ADR%20010%20-%20Combined%20Single-Transaction%20Multi-Space%20Apply.md).

## Consequences at the time

- The browser's version mechanism enforced the order of migrations. No custom lock was needed.
- The `storageHash` comparison in `verifyMarker()` enforced correctness.
- The manifest was the only record of which version the database was at. Losing it meant re-running migrations from version 1.

## Related

- [ADR 002](ADR%20002%20-%20Two-Phase%20Migration.md): how the schema changes and the marker commit together.
