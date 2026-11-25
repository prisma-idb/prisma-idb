---
"@prisma-idb/client-idb": patch
---

An update that changes a field other rows reference now writes that row before the children its `onUpdate` actions rewrite, and a child rewritten by `SetNull` or `SetDefault` on delete is written before its own children. Sync pushes events in write order and the server applies them one at a time, so a child is no longer pushed pointing at a key the server doesn't have yet.
