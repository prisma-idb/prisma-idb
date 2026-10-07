# `@prisma-idb/driver-idb`

The IndexedDB driver for Prisma 8. It runs query plans against the browser's IndexedDB API and manages connections and transactions.

Install it as a dev dependency; `prisma.config.ts` needs `@prisma-idb/driver-idb/control`, a stub, because the framework requires a driver. Apps don't import it directly; `@prisma-idb/client-idb` does.

```bash
npm install --save-dev @prisma-idb/driver-idb
```

Part of [Prisma 8 IDB](https://prisma-idb.dev/docs/prisma-8), a typed IndexedDB client for Prisma 8. Start with the [Quick Start](https://prisma-idb.dev/docs/prisma-8/getting-started). For how the packages fit together, see [ARCHITECTURE.md](https://github.com/prisma-idb/prisma-idb/blob/main/packages/prisma-orm/docs/ARCHITECTURE.md).

## Update identity

`update` and `scan-write` preserve the existing primary key. Changing an inline key rejects with `IdbExecuteError` code `PRIMARY_KEY_CHANGE_UNSUPPORTED` and aborts the transaction. Repeating an equivalent key is allowed, including compound, date and binary keys.

Primary keys are immutable. Delete the row and create it again only after handling dependent records. Restrictive relations can block the delete, and cascading relations can delete dependent records. See [ADR 020](../docs/adrs/ADR%20020%20-%20Primary%20Keys%20Are%20Immutable.md) for the reasons.

## License

MIT
