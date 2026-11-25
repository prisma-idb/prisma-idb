---
"@prisma-idb/family-idb": patch
---

Breaking: TypeScript one-to-one relations now validate the direction and uniqueness of their joins.

- In TypeScript, the referenced side of a one-to-one (a `1:1` paired with an `N:1`, or one that joins on its own primary key) now defaults to optional, and `nullable: false` on it fails with `IDB_INVALID_RELATION`. Before, it defaulted to required when the joined key was required, so its type was non-null although a user with no profile loads `null`.
- A one-to-one foreign key and the tuple it references must each be unique. Authoring fails with `IDB_INVALID_RELATION` when either lacks a primary key or a unique index over its fields. Compound joins can list the same field pairs in any order. A declared reciprocal `N:1` or `1:N` determines ownership even when the local fields are also a primary key.
- A `1:1` without an identifiable foreign-key owner fails with `IDB_INVALID_RELATION` when it declares `onDelete` or `onUpdate`. Declare `N:1` on the model that holds the foreign key. A read through an unowned `1:1` still requires a unique target tuple so `include()` can return a single match.
