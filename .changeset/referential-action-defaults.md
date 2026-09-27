---
"@prisma-idb/client-idb": minor
"@prisma-idb/target-idb": patch
---

Referential actions now match what Postgres does with the same Prisma 8 schema, so a synced app's client and server allow the same changes.

- **`onUpdate` defaults to `restrict`**, not `cascade`. Changing a value that children refer to now throws unless the relation declares `onUpdate: Cascade`, `SetNull` or `SetDefault`. Prisma 8 emits no `ON UPDATE` clause for an undeclared action, so Postgres rejects the change; the client used to cascade it locally and then fail on push.
- **`noAction` behaves like `restrict`**, as `NO ACTION` does in SQL. It used to turn enforcement off, so the client would delete or change a parent that the server refused to, leaving dangling references locally.
