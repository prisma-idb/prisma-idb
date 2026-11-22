---
"@prisma-idb/target-idb": patch
"@prisma-idb/sync-extension-idb": minor
"@prisma-idb/sync-server-sql": patch
---

The built-in HTTP sync now sends `BigInt` and `Bytes` values. Before, pushing an edit with a `bigint` threw before the request was sent, which stalled the outbox, and a `Uint8Array` reached the server as a numeric-keyed object. On the server, a pulled or rejected row with a `BigInt` or `Bytes` column made the response fail to serialize.

- **Breaking for custom transports:** `SyncRequestContext` has a new required `contract` property. TypeScript code that builds a context by hand and passes it to a push handler, such as `createSyncFetchHandlers(...).pushHandler(events, signal, { storageHash })`, no longer type-checks until it passes the client contract too. A handler that only receives the context from the worker needs no change. A custom push handler that serializes events itself must call the new `toWireEvent(context.contract, event)` before `JSON.stringify`.
- `createSyncFetchHandlers` encodes each event through the client contract's codecs: `BigInt` as a string, `Bytes` as base64 and `DateTime` as an ISO string. `toWireEvent` throws a `TypeError` when the contract is missing, instead of sending unencoded values, and a `WireEncodeError` when a codec can't encode the event, such as one holding an invalid date. The fetch handlers fail only that event, with `retryable: false` and the error message, and still send the rest of the batch. A bulk delete's key range is sent as it is.
- `createSqlSync` encodes pulled records and the records it returns with rejected pushes the same way.
- `@prisma-idb/target-idb/runtime` exports `encodeJsonRecord` and `encodeJsonFieldValue`, the counterparts of `decodeJsonRecord`.
- `@prisma-idb/sync-extension-idb/client` exports `toWireEvent` and `WireEncodeError`.
