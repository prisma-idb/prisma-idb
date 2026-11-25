---
"@prisma-idb/sync-extension-idb": minor
---

HTTP sync encodes BigInt, DateTime and Bytes with the client contract, including binary delete keys and range bounds. It reports a permanent failure for each event that fails to encode or serialize and sends the rest of the batch.

`SyncRequestContext` now requires `contract`. The worker supplies this automatically. If you construct a context yourself, pass the client contract. A custom JSON transport must call `toWireEvent` and handle encoding and serialization failures per event.

After upgrading, previously queued outbox events with a Date, BigInt, bytes, an undefined object member or another non-JSON value inside a Json field fail permanently. The worker records the failure on the event and continues with the rest of the batch.
