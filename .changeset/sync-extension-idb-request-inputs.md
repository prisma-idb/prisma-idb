---
"@prisma-idb/sync-extension-idb": minor
---

Move the sync storage hash from a custom header into the push JSON body and pull query. Remove `STORAGE_HASH_HEADER` and require the hash in the request schemas. Breaking: deploy the updated client and server together.
