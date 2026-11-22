---
"@prisma-idb/family-idb": patch
---

Two models with the same store name now fail with `IDB_DUPLICATE_STORE_NAME`, in PSL and TypeScript. Before, the second model's store replaced the first, so `model Todo` and `model todo` compiled to one store with the wrong layout for one of them.

In PSL, two indexes with the same name, such as `@@unique([a], name: "both")` and `@@index([b], name: "both")`, now fail with `IDB_INVALID_INDEX`. Before, the second silently replaced the first, which could drop a uniqueness constraint.
