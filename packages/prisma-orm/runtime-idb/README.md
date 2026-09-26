# `@prisma-idb/runtime-idb`

The IndexedDB runtime for Prisma 8. It connects the adapter and driver, runs middleware, and checks that the database matches the contract.

You don't install it yourself; `@prisma-idb/client-idb` depends on it. Import `createIdbRuntime` from `@prisma-idb/runtime-idb/runtime` only if you're building your own client.

Part of [Prisma 8 IDB](https://prisma-idb.dev/docs/prisma-8), a typed IndexedDB client for Prisma 8. Start with the [Quick Start](https://prisma-idb.dev/docs/prisma-8/getting-started). For how the packages fit together, see [ARCHITECTURE.md](https://github.com/prisma-idb/prisma-idb/blob/main/packages/prisma-orm/docs/ARCHITECTURE.md).

## License

MIT
