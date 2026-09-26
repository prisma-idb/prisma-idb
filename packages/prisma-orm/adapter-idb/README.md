# `@prisma-idb/adapter-idb`

The IndexedDB adapter for Prisma 8. It maps Prisma types to how IndexedDB stores them, declares what IndexedDB can do, and passes query plans from the ORM to the driver.

Install it as a dev dependency; `prisma.config.ts` uses `@prisma-idb/adapter-idb/control`. Apps don't import it directly; `@prisma-idb/client-idb` does.

```bash
npm install --save-dev @prisma-idb/adapter-idb
```

Part of [Prisma 8 IDB](https://prisma-idb.dev/docs/prisma-8), a typed IndexedDB client for Prisma 8. Start with the [Quick Start](https://prisma-idb.dev/docs/prisma-8/getting-started). For how the packages fit together, see [ARCHITECTURE.md](https://github.com/prisma-idb/prisma-idb/blob/main/packages/prisma-orm/docs/ARCHITECTURE.md).

## License

MIT
