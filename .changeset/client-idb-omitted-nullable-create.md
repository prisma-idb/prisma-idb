---
"@prisma-idb/client-idb": minor
---

Let create inputs omit nullable fields, as Prisma Client does, in the types and at runtime. `create`, `createAll`, `createCount`, `upsert` and nested creates store `null` for each nullable field the input leaves out or sets to `undefined`, so stored rows stay complete. Required fields must still be supplied, and updates still validate only the fields they set.
