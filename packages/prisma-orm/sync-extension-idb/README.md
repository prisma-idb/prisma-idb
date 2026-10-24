# `@prisma-idb/sync-extension-idb`

The browser side of Prisma 8 IDB sync. It records writes to tracked models in an outbox, in the same IndexedDB transaction as the write, and runs a worker that pushes those changes to your server and pulls the server's changes back. Writes made offline wait until the connection returns.

```bash
npm install @prisma-idb/sync-extension-idb
```

```ts
import { createManagedAutoSyncIdbClient, createSyncFetchHandlers } from "@prisma-idb/sync-extension-idb/client";
import { idbSyncExtension } from "@prisma-idb/sync-extension-idb/control";
import { contractSpace } from "./prisma/contract-space.generated";

const managedDb = createManagedAutoSyncIdbClient({ contractSpace, dbName: "my-app", extensions: [idbSyncExtension] });

const db = await managedDb.get();
const worker = db.createSyncWorker(
  createSyncFetchHandlers({
    pushUrl: "/api/sync/push",
    pullUrl: "/api/sync/pull",
  })
);
worker.on("error", (error) => {
  console.error("Sync failed:", error.message);
});
worker.start();
```

`createSyncFetchHandlers` sends the storage hash and throws `ContractMismatchError` automatically on HTTP 409. It supports custom `fetch`, `headers` and `credentials` options.

Custom handlers also receive `context.storageHash`. Send it to the server, which refuses a client on a different contract; throw `ContractMismatchError` from the handler on HTTP 409. See [Contract check](https://prisma-idb.dev/docs/prisma-8/sync/server#contract-check).

`trackedModels` defaults to `"*"`; pass model names to keep other writes local. Tracked models need keys that are unique across devices, such as `uuid()` or `cuid()`. Auto-incremented keys are rejected for tracked stores.

`db.on("outboxwrite", callback)` fires after commit, once per tracked IndexedDB write call. Bulk calls can report several entries. Nested or cascading ORM writes can produce several notifications. Rolled-back writes produce none.

`worker.status` and `statuschange` use lowercase values: `"idle"`, `"pushing"`, `"pulling"`, `"error"`, and `"stopped"`. The legacy generated worker uses uppercase statuses and a different status object. Keep lowercase comparisons when migrating to this package.

`worker.on("error", callback)` receives the thrown `Error` after the status becomes `"error"`. This includes push, pull, timeout, and cursor persistence failures. Error subclasses, stacks, and causes are preserved. A thrown value that is not an `Error` is wrapped with `String(value)` as its message and the original value as its `cause`. If string conversion throws, the message is `"Sync cycle failed"`. Listener exceptions are ignored so other subscribers still receive notifications and sync failures keep their original rejection. Each failed cycle emits once, including when concurrent callers share it. Failures that settle after `stop()` do not emit an error event.

`forceSync()` reports failures through the same event and sets status to `"error"`. Its promise still rejects with the original thrown value, so callers must handle that rejection. Successful cycles return the status to `"idle"`. Per-event server rejections are reported through `pushcompleted` and outbox errors; they do not emit a cycle error unless the cycle throws.

The worker automatically keeps the newest 100 successfully acknowledged outbox events per database, ordered by `createdAt` descending and event id descending for ties. It prunes before each cycle's first push, including idle cycles, and after each push-result batch in the same transaction as the results. Unsent and failed events keep their full payload and error, including permanent rejections. Version metadata is preserved. This cleanup applies only to the worker; direct calls to low-level outbox helpers such as `markSynced` do not prune history.

The server side uses [`@prisma-idb/sync-server`](https://www.npmjs.com/package/@prisma-idb/sync-server).

## Entry points

| Import                                   | Contains                                                                                                                                                                                              |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@prisma-idb/sync-extension-idb/client`  | `createSyncIdbClient`, `createAutoMigratingSyncIdbClient`, `createManagedAutoSyncIdbClient`, `createSyncWorker`, `createSyncFetchHandlers`, `ContractMismatchError`, `applyPull`, and outbox helpers. |
| `@prisma-idb/sync-extension-idb/control` | `idbSyncExtension`: the sync stores and their migrations, passed to `extensions`.                                                                                                                     |
| `@prisma-idb/sync-extension-idb/schemas` | Zod schemas for the push and pull wire formats. Safe to import on a server.                                                                                                                           |

`applyPull` validates decoded records and keys before opening a write transaction. Both its result and the worker's `pullcompleted` event include `validationFailed`, a subset of `skipped`, for corrupt records, keys or wire values. Valid rows still apply, and corrupt rows advance the pull cursor without changing their per-record version metadata. Extra fields and undeclared enum values are rejected; a newer server shape can require updating the client contract.

The `pullcompleted` event and `applyPull` result also include `changes: PullChange[]`: one `{ model, key, op }` per committed changelog entry, in page order. Keys are native IndexedDB values; compound keys follow the contract's field order. The operation matches the changelog, except revoked ownership is reported as `delete`. Skipped and rolled-back entries are excluded. A delete can cascade to related rows or set their foreign keys to null. Those side effects are not separate entries, so consumers should also invalidate queries for related models. Each page gets its own list, including an empty list when nothing applies. `PullChange` is exported from `/client`.

The pull cursor is persisted in `_idb_sync_meta` in the same IndexedDB database as application data. The `getCursor` and `setCursor` worker options have been removed. On sign-out, await `worker.stop()` before your managed client's `reset()`. Stopping waits for the active cycle to settle and suppresses subsequent cycle notifications. Resetting clears the cursor with the data.

**Breaking change:** the sync migration history is replaced by one baseline. Recreate existing browser databases before using this version. Resetting discards queued local edits, so sync them before upgrading when possible.

## Documentation

- [Sync tutorial](https://prisma-idb.dev/docs/prisma-8/sync)
- [Sync client reference](https://prisma-idb.dev/docs/prisma-8/sync/client)

## License

MIT

## Schema enums

Sync clients expose Prisma 8 runtime enum accessors through `db.enums`, shared with `db.rawClient.enums`. For the default PSL namespace, use `db.enums.__unbound__.Role.members.ADMIN` or `db.enums.__unbound__.Role.values`. Membership checks such as `Role.has(value)` narrow to the declared value union. Existing field types and string literals keep working.
