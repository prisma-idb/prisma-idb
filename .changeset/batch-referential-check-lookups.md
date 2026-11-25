---
"@prisma-idb/client-idb": patch
---

Checking the foreign keys that referential actions changed looks each parent tuple up once and scans an unindexed parent store at most once per write, instead of once per changed row.
