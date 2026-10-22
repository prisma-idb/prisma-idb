---
"@prisma-idb/client-idb": patch
---

Defer the managed client’s default IndexedDB factory lookup until database reset. Managed clients, including managed sync clients, can now be created during server rendering without a global `indexedDB`. Explicit factory overrides remain supported.
