# `@prisma-idb/sync-extension-idb`

The browser side of Prisma 8 IDB sync. It records writes to tracked models in an outbox, in the same IndexedDB transaction as the write, and runs a worker that pushes those changes to your server and pulls the server's changes back. Writes made offline wait until the connection returns.

```bash
npm install @prisma-idb/sync-extension-idb
```

```ts
import { ContractMismatchError, createManagedAutoSyncIdbClient } from "@prisma-idb/sync-extension-idb/client";
import { idbSyncExtension } from "@prisma-idb/sync-extension-idb/control";
import { contractSpace } from "./prisma/contract-space.generated";

const managedDb = createManagedAutoSyncIdbClient({ contractSpace, dbName: "my-app", extensions: [idbSyncExtension] });

const db = await managedDb.get();
const worker = db.createSyncWorker({
  pushHandler: async (events, signal, context) => {
    const response = await fetch("/api/sync/push", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-contract-fingerprint": await context.contractFingerprint(),
      },
      body: JSON.stringify({ events }),
      signal,
    });
    if (response.status === 409) throw new ContractMismatchError();
    return response.json();
  },
  pullHandler: async (since, signal, context) => {
    const response = await fetch(`/api/sync/pull?since=${since ?? ""}`, {
      headers: { "x-contract-fingerprint": await context.contractFingerprint() },
      signal,
    });
    if (response.status === 409) throw new ContractMismatchError();
    return response.json();
  },
});
worker.start();
```

Each handler also receives `context.contractFingerprint()`. Send it to the server, which refuses a client on a different contract; throw `ContractMismatchError` from the handler on HTTP 409. See [Contract fingerprint](https://prisma-idb.dev/docs/prisma-8/sync/server#contract-fingerprint).

`trackedModels` defaults to `"*"`; pass model names to keep other writes local. Tracked models need keys that are unique across devices, such as `uuid()` or `cuid()`. Auto-incremented keys are rejected for tracked stores.

`db.on("outboxwrite", callback)` fires after commit, once per tracked IndexedDB write call. Bulk calls can report several entries. Nested or cascading ORM writes can produce several notifications. Rolled-back writes produce none.

The server side uses [`@prisma-idb/sync-server`](https://www.npmjs.com/package/@prisma-idb/sync-server).

## Entry points

| Import                                   | Contains                                                                                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@prisma-idb/sync-extension-idb/client`  | `createSyncIdbClient`, `createAutoMigratingSyncIdbClient`, `createManagedAutoSyncIdbClient`, `createSyncWorker`, `applyPull`, and outbox helpers. |
| `@prisma-idb/sync-extension-idb/control` | `idbSyncExtension`: the sync stores and their migrations, passed to `extensions`.                                                                 |
| `@prisma-idb/sync-extension-idb/schemas` | Zod schemas for the push and pull wire formats. Safe to import on a server.                                                                       |

`applyPull` validates decoded records and keys before opening a write transaction. Both its result and the worker's `pullcompleted` event include `validationFailed`, a subset of `skipped`, for corrupt records, keys or wire values. Valid rows still apply, and corrupt rows advance the pull cursor without changing their per-record version metadata. Extra fields and undeclared enum values are rejected; a newer server shape can require updating the client contract.

## Documentation

- [Sync tutorial](https://prisma-idb.dev/docs/prisma-8/sync)
- [Sync client reference](https://prisma-idb.dev/docs/prisma-8/sync/client)

## License

MIT
