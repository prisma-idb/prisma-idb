---
"@prisma-idb/family-idb": patch
---

PSL pairs backrelations with their foreign keys as upstream Prisma does.

- A backrelation pairs with the foreign key that has the same `@relation("...")` name. Before, the name was ignored and every backrelation between two models joined through the last foreign key declared, so with `written Post[] @relation("Written")` and `edited Post[] @relation("Edited")` both relations joined on `editorId`. An empty name, `@relation("")`, counts as no name.
- PSL accepts the other side of a one-to-one as a singular backrelation. `profile Profile?` on `User` pairs with `user User @relation(fields: [userId], references: [id])` on `Profile` and lowers to the same `1:1` relation as TypeScript. Before, it failed with `IDB_MISSING_RELATION_ATTRIBUTE`, or with `IDB_INVALID_RELATION` when it had `@relation("...")`. A singular backrelation follows the rules for the referenced side of a one-to-one in TypeScript: it must be optional, and its foreign key must be unique, or it fails with `IDB_INVALID_RELATION`. Several singular backrelations can point to the same unambiguous foreign key, as list backrelations already could.
- A named backrelation that matches no relation name reports `IDB_UNRESOLVED_BACKRELATION` with the names it found, instead of asking for an `@relation(fields: [...])` that already exists.
- If the owning relation omits `fields` or `references`, names an unknown referenced field, or references a navigation field, the diagnostic identifies the owning relation without a second unresolved diagnostic for the first matching backrelation.

Breaking:

- A backrelation that matches several foreign keys fails with `IDB_AMBIGUOUS_BACKRELATION`, for example an unnamed `posts Post[]` when `Post` has both an `author` and an `editor` relation to `User`. Name both sides with the same `@relation("...")`.
- A backrelation, list or singular, that declares `onDelete` or `onUpdate` fails with `IDB_INVALID_RELATION`, as upstream refuses actions on the side without the foreign key. A backrelation also refuses other attributes, such as `@default` and `@unique`, with `PSL_UNSUPPORTED_FIELD_ATTRIBUTE`.
- A list relation field that declares `fields` or `references` fails with `IDB_INVALID_RELATION`. Before, the interpreter could accept these arguments when it found a matching foreign key on the other side.
