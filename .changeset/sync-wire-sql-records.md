---
"@prisma-idb/sync-server-sql": patch
---

Encode and revive BigInt, Bytes and DateTime on HTTP sync routes, including scalar list elements and PostgreSQL timestamps without a time zone represented as JavaScript Date values. Json and Jsonb columns are checked like client `Json` writes. If encoding or serializing a rejected record fails, the push still reports applied results and logs the error. A pull log that fails to encode or serialize, including one with a Json value JSON can't represent, returns HTTP 500 and identifies the changelog entry.
