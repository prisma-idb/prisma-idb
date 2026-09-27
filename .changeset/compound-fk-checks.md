---
"@prisma-idb/client-idb": minor
---

Foreign keys are now checked on every write that sets one.

- **Compound foreign keys are checked as one tuple.** A plain write that set a compound foreign key used to throw "not supported". Now a single parent row must match every field. When an update sets only some fields of the key, the rest come from the row being updated. A key with any `null` field isn't checked, like SQL's `MATCH SIMPLE`.
- **`setDefault` works on compound relations**, checking that one parent matches the whole default tuple. It used to throw.
- **`createAll()` and `createCount()` check foreign keys.** They used to skip the check entirely. Rows that set a foreign key are now checked and inserted in one transaction, so one bad row writes nothing.
- **`upsert()` checks foreign keys** on both its create and update branches. It used to check neither.
- A foreign key that references a compound primary key is checked with a key-only lookup, in any field order.
