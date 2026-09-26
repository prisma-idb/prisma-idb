# `@prisma-idb/target-idb`

The IndexedDB target for Prisma 8: codecs, contract storage types, key comparison, and the migration system (planner, operations, and the code that applies them in the browser).

Install it as a dev dependency; `prisma.config.ts` uses `@prisma-idb/target-idb/control`. Migration files import `@prisma-idb/target-idb/migration`. Apps don't import it at run time; `@prisma-idb/client-idb` does.

```bash
npm install --save-dev @prisma-idb/target-idb
```

Part of [Prisma 8 IDB](https://prisma-idb.dev/docs/prisma-8), a typed IndexedDB client for Prisma 8. Start with the [Quick Start](https://prisma-idb.dev/docs/prisma-8/getting-started). For how the packages fit together, see [ARCHITECTURE.md](https://github.com/prisma-idb/prisma-idb/blob/main/packages/prisma-orm/docs/ARCHITECTURE.md).

## License

MIT
