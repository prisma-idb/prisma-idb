---
"@prisma-idb/target-idb": minor
---

Breaking change: generated IDB store definitions include record shapes in storage hashes. Export the record shape types for scalar codecs, enums, and nested value objects. DDL continues to use only store and index options.
