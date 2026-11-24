---
"@prisma-idb/family-idb": patch
---

A PSL backrelation now pairs with the foreign key that has the same `@relation("...")` name. Before, the name was ignored and every backrelation between two models joined through the last foreign key declared, so with `written Post[] @relation("Written")` and `edited Post[] @relation("Edited")` both relations joined on `editorId`. Breaking: a backrelation that matches several foreign keys now fails with `IDB_AMBIGUOUS_BACKRELATION`, for example an unnamed `posts Post[]` when `Post` has both an `author` and an `editor` relation to `User`. Name both sides with the same `@relation("...")` to fix it.
