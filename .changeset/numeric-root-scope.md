---
"@prisma-idb/sync-server": patch
"@prisma-idb/sync-server-sql": patch
---

A tenant root with an `Int` or `Float` key now authorizes. The scope key is always a string, and a numeric root key arrives as a JSON number, so the strict comparison refused every write and pull for scope `"7"` and key `7`, for the root and for its descendants. A numeric key now matches the scope that spells it. `@prisma-idb/sync-server` exports the comparison as `sameScopeKey`.
