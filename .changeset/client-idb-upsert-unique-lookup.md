---
"@prisma-idb/client-idb": patch
---

Reject upsert lookup filters that do not include a complete primary key or declared unique index. Compound keys require every member. Null and other invalid IndexedDB key values cannot establish uniqueness. The existing `where`, `create`, and `update` API and atomic transaction behavior are preserved.
