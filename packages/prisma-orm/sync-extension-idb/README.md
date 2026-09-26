# `@prisma-idb/sync-extension-idb`

The browser side of Prisma 8 IDB sync. It records every write in an outbox, in the same IndexedDB transaction as the write, and runs a worker that pushes those changes to your server and pulls the server's changes back. Writes made offline wait until the connection returns.

```bash
npm install @prisma-idb/sync-extension-idb
```

```ts
import { createManagedAutoSyncIdbClient } from "@prisma-idb/sync-extension-idb/client";
import { idbSyncExtension } from "@prisma-idb/sync-extension-idb/control";
import { contractSpace } from "./prisma/contract-space.generated";

const managedDb = createManagedAutoSyncIdbClient({ contractSpace, dbName: "my-app", extensions: [idbSyncExtension] });

const db = await managedDb.get();
const worker = db.createSyncWorker({
  pushHandler: (events, signal) =>
    fetch("/api/sync/push", { method: "POST", body: JSON.stringify({ events }), signal }).then((r) => r.json()),
  pullHandler: (since, signal) => fetch(`/api/sync/pull?since=${since ?? ""}`, { signal }).then((r) => r.json()),
});
worker.start();
```

The server side uses [`@prisma-idb/sync-server`](https://www.npmjs.com/package/@prisma-idb/sync-server).

## Entry points

| Import                                   | Contains                                                                                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@prisma-idb/sync-extension-idb/client`  | `createSyncIdbClient`, `createAutoMigratingSyncIdbClient`, `createManagedAutoSyncIdbClient`, `createSyncWorker`, `applyPull`, and outbox helpers. |
| `@prisma-idb/sync-extension-idb/control` | `idbSyncExtension`: the sync stores and their migrations, passed to `extensions`.                                                                 |
| `@prisma-idb/sync-extension-idb/schemas` | Zod schemas for the push and pull wire formats. Safe to import on a server.                                                                       |

## Documentation

- [Sync tutorial](https://prisma-idb.dev/docs/prisma-8/sync)
- [Sync client reference](https://prisma-idb.dev/docs/prisma-8/sync/client)

## License

MIT
