---
"@prisma-idb/sync-server-sql": minor
---

Reject cross-user parent references on creates and merged updates before entity and changelog writes. This tightens write acceptance by default, including lower-level calls without parent descriptors. Preserve OR read/delete authorization and authorized rejection reconciliation. Reject unsupported checked joins and FK defaults explicitly.
