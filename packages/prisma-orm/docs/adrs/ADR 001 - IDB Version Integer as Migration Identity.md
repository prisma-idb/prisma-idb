# ADR 001 — IDB Version Integer as Migration Identity

## Context

The upstream framework ([ADR 001 — Migrations as Edges](https://github.com/prisma/prisma-next/blob/main/docs/architecture%20docs/adrs/ADR%20001%20-%20Migrations%20as%20Edges.md)) models migrations as directed edges in a contract-hash graph: each migration moves from `fromHash` to `toHash`, and the runner refuses to apply if the database marker doesn't match `fromHash`. This gives deterministic, content-addressed drift detection.

IndexedDB's DDL mechanism is mechanically incompatible with this model. The browser only triggers the `upgradeneeded` callback — the only place DDL is permitted — when `IDBFactory.open(name, version)` is called with an integer `version` higher than the stored version. There is no way to substitute a hash comparison at the browser API level. The integer is not optional; it is the only handle.

## Decision

Use IDB's native integer version counter (`idbVersion` in the manifest) as the mechanism for triggering DDL, and use `storageHash` in the `_prisma_next_marker` object store as the content-verification layer. These are two separate mechanisms that together do the combined job of the upstream edge model.

- `idbVersion` is a monotone integer (1, 2, 3…) stored in the manifest. Before each migration the caller computes `targetVersion = (manifest.idbVersion ?? 0) + 1` and calls `factory.open(dbName, targetVersion)`.
- `storageHash` is the canonical hash of the contract's storage section. It is written into `_prisma_next_marker` by the migration runner after DDL succeeds. The runtime reads it on `verifyMarker()` and compares against `contract.storage.storageHash`.
- After a successful migration the caller writes `idbVersion: targetVersion` back to the manifest and calls `family.sign()` to update the marker.

### What each mechanism provides

| Mechanism                   | What it guarantees                                                        |
| --------------------------- | ------------------------------------------------------------------------- |
| `idbVersion` integer        | DDL fires in monotone order; IDB enforces that versions never go backward |
| `storageHash` in marker     | The schema content that was applied matches what the contract expects     |
| `verifyMarker()` at runtime | Queries are blocked until a matching migration has been applied           |

### Safe failure mode

If someone externally bumps the IDB version (outside the migration runner), the integer advances but the marker is not written (or is stale). `verifyMarker()` returns `false` and all queries are blocked. This is a safe, detectable failure — the application refuses to execute until migrations are run through the proper path.

## What we deliberately did not do

**Full hash-based edge model in IDB:** The upstream `fromHash → toHash` directed-edge model requires a content-addressed identity for each migration step and refuses to apply if the database is not at `fromHash`. We cannot use content hashes to trigger IDB DDL — the browser's version-change mechanism is integer-only. Attempting to store "from hash" and "to hash" in the manifest and use them for applicability checks would require opening a pre-DDL connection to read the current marker, then deciding whether to trigger DDL, which is an extra round-trip with no browser-level enforcement. The integer + hash combination covers the same safety properties with IDB's native primitives.

**ledger / audit trail:** The upstream marker (ADR 021) includes `invariants[]`, `contract_json`, `canonical_version`, and `app_tag` for audit and multi-space support. IDB targets are single-origin, single-process, no extension packs, no multi-tenant schemas. A minimal marker (`storageHash`, `profileHash`, `updatedAt`) is sufficient and avoids over-engineering for a browser-local store.

## Consequences

- Migration ordering is enforced by IDB's browser-native version mechanism — no custom lock, no advisory lock needed.
- Content correctness is enforced by the `storageHash` comparison in `verifyMarker()`.
- The manifest's `idbVersion` is the only on-disk record of "which DDL version the database is at." Losing the manifest means re-running migrations from version 1 (which is idempotent for additive schemas, non-idempotent for drops).
- The manifest must be written atomically and durably before the application is allowed to serve queries against the new schema.

## Related

- Upstream ADR 001 — Migrations as Edges (the model we adapted from)
- Upstream ADR 021 — Contract Marker Storage (the marker model we simplified)
- [ADR 002](ADR%20002%20-%20Two-Phase%20Migration.md) — why the marker write is a separate transaction from DDL
