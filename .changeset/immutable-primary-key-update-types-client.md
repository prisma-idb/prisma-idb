---
"@prisma-idb/client-idb": minor
---

Exclude primary-key fields from `update`, `updateAll`, `updateCount`, and `upsert.update` input types. This is a breaking type change: ported Prisma code that sets `id` in update data stops compiling, even when it repeats the existing key. For dotted key paths, the containing field is excluded because updates shallow-merge records. Create inputs are unchanged, and runtime protection remains for untyped callers.
