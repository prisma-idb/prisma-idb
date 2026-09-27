# `@prisma-idb/driver-idb`

The IndexedDB driver for Prisma 8. It runs query plans against the browser's IndexedDB API and manages connections and transactions.

Install it as a dev dependency; `prisma.config.ts` needs `@prisma-idb/driver-idb/control`, a stub, because the framework requires a driver. Apps don't import it directly; `@prisma-idb/client-idb` does.

```bash
npm install --save-dev @prisma-idb/driver-idb
```

Part of [Prisma 8 IDB](https://prisma-idb.dev/docs/prisma-8), a typed IndexedDB client for Prisma 8. Start with the [Quick Start](https://prisma-idb.dev/docs/prisma-8/getting-started). For how the packages fit together, see [ARCHITECTURE.md](https://github.com/prisma-idb/prisma-idb/blob/main/packages/prisma-orm/docs/ARCHITECTURE.md).

## License

MIT
