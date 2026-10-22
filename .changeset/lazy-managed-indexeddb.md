---
"@prisma-idb/client-idb": patch
---

Defer the managed client’s default IndexedDB factory lookup until opening or resetting the database. Managed clients, including managed sync clients, can now be created during server rendering without a global `indexedDB`. Reset uses the factory captured when opening the client, even if the global factory later changes. Explicit factory overrides remain supported.
