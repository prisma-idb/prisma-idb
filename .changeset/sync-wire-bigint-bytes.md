---
"@prisma-idb/sync-extension-idb": minor
---

HTTP sync encodes BigInt, DateTime and Bytes with the client contract, including binary delete keys and range bounds. It reports a permanent failure for each event that fails to encode or serialize and sends the rest of the batch.

`SyncRequestContext` now requires `contract`. The worker supplies this automatically. If you construct a context yourself, pass the client contract. A custom JSON transport must call `toWireEvent` and handle encoding and serialization failures per event.
