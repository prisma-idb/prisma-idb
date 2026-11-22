---
"@prisma-idb/target-idb": patch
"@prisma-idb/sync-extension-idb": patch
"@prisma-idb/sync-server-sql": patch
---

The built-in HTTP sync now sends `BigInt` and `Bytes` values. Before, pushing an edit with a `bigint` threw before the request was sent, which stalled the outbox, and a `Uint8Array` reached the server as a numeric-keyed object. On the server, a pulled or rejected row with a `BigInt` or `Bytes` column made the response fail to serialize.

- `createSyncFetchHandlers` encodes each event through the client contract's codecs: `BigInt` as a string, `Bytes` as base64 and `DateTime` as an ISO string. The worker's request context now carries the client `contract`. A custom push handler should call the new `toWireEvent(context.contract, event)` before `JSON.stringify`.
- `createSqlSync` encodes pulled records and the records it returns with rejected pushes the same way.
- `@prisma-idb/target-idb/runtime` exports `encodeJsonRecord` and `encodeJsonFieldValue`, the counterparts of `decodeJsonRecord`.
