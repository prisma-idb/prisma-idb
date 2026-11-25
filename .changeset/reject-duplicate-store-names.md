---
"@prisma-idb/family-idb": patch
---

Breaking: two models with the same store name now fail with `IDB_DUPLICATE_STORE_NAME` in PSL and TypeScript. Before, the second model's store replaced the first, so `model Todo` and `model todo` compiled to one store with the wrong layout for one of them. Give each model its own store name, with `@@map` in PSL or `store` in TypeScript.
