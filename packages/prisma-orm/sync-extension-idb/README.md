# @prisma-idb/sync-extension-idb

Browser-side outbox sync extension for the Prisma 8 IDB family. Wraps your IDB ORM client to atomically write outbox events alongside every mutation, then provides a `SyncWorker` that pushes those events to your server and pulls remote changes back.

## Installation

```bash
pnpm add @prisma-idb/sync-extension-idb
```

## Quick Start

```ts
import { createAutoMigratingIdbClient } from "@prisma-idb/client-idb/client-auto";
import { idbSyncExtension } from "@prisma-idb/sync-extension-idb/control";
import { createSyncIdbClient } from "@prisma-idb/sync-extension-idb/client";
import { contractSpace } from "./prisma/contract-space.generated";

// 1. Migrate the DB — includes both app stores and sync stores.
await createAutoMigratingIdbClient({
  contractSpace,
  dbName: "my-app",
  extensions: [idbSyncExtension],
});

// 2. Create the sync-aware ORM client.
const db = createSyncIdbClient({
  contract: contractSpace.contractJson,
  dbName: "my-app",
});

// 3. Use normally — outbox events are written atomically with every mutation.
await db.orm.users.create({ id: crypto.randomUUID(), name: "Alice" });

// 4. Bypass tracking for local-only writes (e.g. temporary or draft records).
await db.withoutTracking((orm) => orm.users.create({ id: "tmp", name: "Draft" }));

// 5. Start the sync loop.
const worker = db.createSyncWorker({
  pushHandler: async (events) =>
    fetch("/api/sync/push", { method: "POST", body: JSON.stringify(events) }).then((r) => r.json()),
  pullHandler: async (fromId) => fetch(`/api/sync/pull?from=${fromId ?? ""}`).then((r) => r.json()),
});
worker.start();
```

## How It Works

### Outbox Pattern

Every tracked mutation (`create`, `update`, `delete`, `upsert`, and bulk variants) atomically writes an `OutboxEvent` record to `_idb_sync_outbox` in the **same IDB transaction** as the model write. Atomicity is guaranteed: either both the model write and the outbox event commit, or neither does.

The `SyncWorker` picks up unsynced events, sends them to your push endpoint in batches, and marks them synced on success. It also pulls server changes via your pull endpoint and applies them locally using `applyPull`.

### VersionMeta

`_idb_sync_version_meta` tracks two things per record:

- **`localChangePending`** — set to `true` when a local mutation is written; cleared when that mutation is confirmed synced. Prevents an incoming pull from overwriting a locally-modified record before it's been pushed.
- **`lastAppliedChangeId`** — updated on every successful pull. Prevents applying a stale server change if the local record is already newer.

### `withoutTracking`

Some writes should never reach the server: temporary UI state, draft records, or data loaded from the server via `applyPull`. Pass a callback to `withoutTracking` to use the raw ORM directly — no outbox events, no version meta updates.

```ts
await db.withoutTracking(async (orm) => {
  await orm.localNotes.create({ id: "draft-1", body: "..." });
});
```

### Extension Migrations

The `migrations/` directory in this package contains the baseline migration for the `idb-sync` contract space. It creates `_idb_sync_outbox` and `_idb_sync_version_meta` independently of your app's stores. When you pass `idbSyncExtension` to `createAutoMigratingIdbClient`, the runner applies this baseline (and any future extension migrations) together with your app schema in a single combined `upgradeneeded` transaction (see ADR 010) — keyed by `space: "idb-sync"` in `_prisma_next_marker` so it versions independently from your app schema.

You never need to generate or edit these migrations manually. Future versions of the package ship updated migration chains automatically.

## Server Side

Pair with `@prisma-idb/server-sync` for server-side push/pull helpers:

```ts
// pages/api/sync/push.ts (Next.js example)
import { processPushBatch } from "@prisma-idb/server-sync";

export async function POST(req: Request) {
  const events = await req.json();
  const results = await processPushBatch(prisma, events, {/* config */});
  return Response.json(results);
}
```

See the `server-sync` package for the full API including changelog queries, DAG-ordered write batching, and type definitions.

## API

### `createSyncIdbClient(options)`

| Option           | Type              | Description                                        |
| ---------------- | ----------------- | -------------------------------------------------- |
| `contract`       | `TContract`       | The resolved IDB contract from your contract space |
| `dbName`         | `string`          | IDB database name — must match the migrated DB     |
| `factory?`       | `IDBFactory`      | IDB factory override (default: `indexedDB`)        |
| `trackedModels?` | `string[] \| '*'` | Models to track (default: `'*'` — all models)      |

Returns a `SyncIdbClient`:

- `.orm` — sync-aware ORM with the same API as `IdbClient.orm`
- `.withoutTracking(fn)` — passes raw ORM to `fn`, no outbox writes
- `.rawClient` — the underlying `IdbClient` (marker verification, raw transactions)
- `.createSyncWorker(options)` — create a `SyncWorker` for this client

### `SyncWorker`

| Method          | Description                                                      |
| --------------- | ---------------------------------------------------------------- |
| `start()`       | Begin push/pull loop on interval                                 |
| `stop()`        | Stop the loop                                                    |
| `forceSync()`   | Trigger one push/pull cycle immediately, ignoring backoff        |
| `on(event, cb)` | Listen to `"statuschange"`, `"pushcompleted"`, `"pullcompleted"` |
| `.status`       | Current `SyncWorkerStatus`                                       |

### `idbSyncExtension`

The `IdbExtensionSpace` descriptor to pass to `createAutoMigratingIdbClient`. Contains the `idb-sync` contract space with the sync stores' migration graph.
