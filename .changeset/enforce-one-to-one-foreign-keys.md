---
"@prisma-idb/client-idb": patch
---

A one-to-one relation declared on the foreign-key side now holds a foreign key like a many-to-one relation, when it points at the referenced model's primary key or pairs with a one-to-many relation there. The client checks the foreign key on writes, runs its referential actions, and sets it through nested `connect()` and `disconnect()`, including when the referenced model declares no inverse. A shared-primary-key one-to-one also matches its inverse when the compound key lists the same fields in another order.
