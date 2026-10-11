---
"@prisma-idb/client-idb": minor
---

Run same-hash migrations containing `transformRecords` once per contract space. Record data-migration progress atomically with record changes so fresh installs and reopened databases skip completed transforms, and aborted upgrades retry them.
