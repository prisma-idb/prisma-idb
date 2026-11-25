---
"@prisma-idb/family-idb": patch
---

In PSL, two indexes with the same name, such as `@@unique([a], name: "both")` and `@@index([b], name: "both")`, now fail with `IDB_INVALID_INDEX`. Before, the later index replaced the earlier one, which could drop a uniqueness constraint. The same applies when a declared name matches a name generated on other fields, such as `@@index([other], name: "email_unique")` next to `email String @unique`; the error says which attribute generated the name. Two declarations with the same name over the same fields still merge into one index, unique if either one is, as upstream Prisma's Mongo authoring does. Give each index in a model its own name.
