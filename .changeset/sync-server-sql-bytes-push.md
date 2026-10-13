---
"@prisma-idb/sync-server-sql": patch
---

Apply pushed updates and deletes to models with Bytes primary keys. Use primary-key-filtered bulk mutations to work around the SQL ORM's single-row mutation bug.
