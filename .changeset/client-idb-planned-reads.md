---
"@prisma-idb/client-idb": minor
---

Route row reads, aggregates, grouped aggregates, and relation includes through the query planner. Use primary keys and indexes for point, membership, prefix, and range filters. Reapply the full filter to every result.

Use index cursor order and early limits for supported single-field ordering with `take`. Keep unsupported filters and ordering correct through full scans and in-memory shaping.
