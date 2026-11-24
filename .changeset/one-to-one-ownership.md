---
"@prisma-idb/family-idb": patch
---

Breaking: one-to-one relations follow upstream Prisma's ownership rules.

- In TypeScript, the referenced side of a one-to-one (a `1:1` paired with an `N:1`, or one that joins on its own primary key) now defaults to optional, and `nullable: false` on it fails with `IDB_INVALID_RELATION`. Before, it defaulted to required when the joined key was required, so its type was non-null although a user with no profile loads `null`.
- The referenced side of a one-to-one must pair with a unique foreign key, or several rows could point at one parent. Without a unique index or primary key over the foreign-key fields, it fails with `IDB_INVALID_RELATION`.
- A `1:1` that neither pairs with an `N:1` nor points at the other model's primary key fails with `IDB_INVALID_RELATION` when it declares `onDelete` or `onUpdate`, because no foreign key backs it and the client never ran the action. Declare `N:1` on the model that holds the foreign key instead.
