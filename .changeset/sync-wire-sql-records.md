---
"@prisma-idb/sync-server-sql": patch
---

Encode and revive BigInt, Bytes and DateTime on HTTP sync routes, including scalar list elements and PostgreSQL timestamps without a time zone represented as JavaScript Date values. If serializing a rejected record fails, the push still reports applied results. A pull log that fails to serialize returns HTTP 500 and identifies the changelog entry.
