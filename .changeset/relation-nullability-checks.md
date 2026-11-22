---
"@prisma-idb/family-idb": patch
---

Two relation shapes that the client couldn't honor now fail with `IDB_INVALID_RELATION`, in PSL and TypeScript:

- A required to-one relation over a nullable foreign key. Its type promised a related row that a `null` key can't provide.
- `onDelete: SetNull` or `onUpdate: SetNull` on a foreign key with a required field. The action would write `null` into a field that refuses it, so the parent's delete or update failed at runtime.
