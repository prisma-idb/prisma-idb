---
"@prisma-idb/sync-server-sql": patch
---

Pushes for the same scope can no longer make a pull skip changelog rows. Each push now takes a transaction-scoped Postgres advisory lock for its scope around the `Changelog` insert, and draws the new UUID v7 id strictly above the scope's current highest id, read under that lock. Previously two concurrent pushes could commit out of id order, and two app servers in the same millisecond (or one with a lagging clock) could draw a smaller id after a larger one had committed; a client whose cursor had passed the larger id then never saw the other row. Different scopes don't contend, and there is no wire or type change. Pushes now require the default READ COMMITTED transaction isolation level: the scope's highest id is read after the lock, and under REPEATABLE READ or SERIALIZABLE that read would use a snapshot taken before it, so `applyPush` fails the event (retryable, logged server-side) instead of risking a skipped row.
