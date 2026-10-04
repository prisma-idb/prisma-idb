---
"@prisma-idb/sync-server": minor
---

Breaking: `SyncPushEvent` replaces the optional `wirePayload` with a required `wireKey`, the record's primary key in its JSON wire form. The ownership check uses it, and a call to `validatePush` without it is now a type error. Pass `wireKey: payload[keyField]` when your keys are strings.
