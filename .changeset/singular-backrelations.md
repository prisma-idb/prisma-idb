---
"@prisma-idb/family-idb": patch
---

PSL accepts the other side of a one-to-one as a singular backrelation, as upstream Prisma does. `profile Profile?` on `User` pairs with `user User @relation(fields: [userId], references: [id])` on `Profile`, by relation name when it has one, and lowers to the same `1:1` relation as TypeScript. Before, it failed with `IDB_MISSING_RELATION_ATTRIBUTE`, or with `IDB_INVALID_RELATION` when it had `@relation("...")`.

A singular backrelation follows the rules for the referenced side of a one-to-one in TypeScript: it must be optional, and its foreign key must be unique, or it fails with `IDB_INVALID_RELATION`.

Breaking: a backrelation, list or singular, that declares `onDelete` or `onUpdate` now fails with `IDB_INVALID_RELATION`, as upstream refuses actions on the side without the foreign key. Before, the action was dropped and the relation kept `Restrict`. Two backrelations that pair with the same foreign key fail with `IDB_AMBIGUOUS_BACKRELATION`.
