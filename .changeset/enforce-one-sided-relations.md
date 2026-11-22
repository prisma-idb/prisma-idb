---
"@prisma-idb/client-idb": patch
---

Referential actions now apply to every foreign key, whether or not the parent model declares the inverse relation. Before, a relation declared only on the child, such as `Post.author` without `User.posts`, was never enforced: deleting the user left posts with a dangling foreign key, even with `onDelete: Cascade`, and a change to a referenced field didn't cascade or restrict. When the parent declares no relation, the error names the child's relation, such as `'Post.author'`.
