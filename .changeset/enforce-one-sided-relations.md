---
"@prisma-idb/client-idb": patch
"@prisma-idb/family-idb": patch
"@prisma-idb/target-idb": patch
---

Referential actions now apply to every many-to-one foreign key, whether or not the parent model declares the inverse relation. A one-to-one relation declared only on the child, which TypeScript authoring allows, is still not enforced, since the contract doesn't say which side of it owns the key. Before, a relation declared only on the child, such as `Post.author` without `User.posts`, was never enforced: deleting the user left posts with a dangling foreign key, even with `onDelete: Cascade`, and a change to a referenced field didn't cascade or restrict. When the parent declares no relation, the error names the child's relation, such as `'Post.author'`.

A one-sided action that would delete or rewrite children (`Cascade`, `SetNull`, `SetDefault`) requires the referenced fields to be the parent's primary key or a unique index. If an existing contract references non-unique fields, the parent write fails while any child exists, instead of changing children that may belong to another parent. This check applies only when the parent doesn't declare the inverse relation; with a declared inverse over non-unique fields, the action still applies to every child whose foreign key matches. A one-sided action rejects an ambiguous legacy Decimal key before changing the children. Parent-side aliases keep their declared actions. Two foreign keys that use the same field pairs in opposite directions keep their own actions. Compound inverses can list the same field pairs in a different order. A row that only references itself can be deleted.

`@prisma-idb/target-idb/pack` exports two helpers that the client and the contract validator share: `sameFieldSet(a, b)`, which compares two field lists as sets, and `sameJoinPairs(leftLocal, leftTarget, rightLocal, rightTarget)`, which compares two relation joins by their field pairs in any order.
