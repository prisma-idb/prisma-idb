---
"@prisma-idb/client-idb": patch
---

`include()` on a relation with a compound foreign key now joins on every field of the relation. It used to join on the first field only, so it attached the wrong rows whenever two parents shared that field's value, such as two members with the same handle in different orgs. A parent with a `null` in any of the fields gets no related rows. The join uses a key range when an index or the related primary key covers exactly the relation's fields, in any order.
