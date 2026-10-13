---
"@prisma-idb/sync-server-sql": minor
---

Project pull responses and rejected-push reconciliation records to client-contract fields after authorization and before wire encoding. Server-only fields are no longer returned.

Behavior change: the lower-level `adapter.resolvePullRecord` now requires the `syncServer` option and throws without it. Pass the `createSyncServer` result when constructing the adapter.
