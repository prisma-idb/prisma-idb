# `@prisma-idb/adapter-idb`

The IndexedDB adapter for Prisma 8. It maps Prisma types to how IndexedDB stores them, declares what IndexedDB can do, and passes query plans from the ORM to the driver.

Install it as a dev dependency; `prisma.config.ts` uses `@prisma-idb/adapter-idb/control`. Apps don't import it directly; `@prisma-idb/client-idb` does.

```bash
npm install --save-dev @prisma-idb/adapter-idb
```

Part of [Prisma 8 IDB](https://prisma-idb.dev/docs/prisma-8), a typed IndexedDB client for Prisma 8. Start with the [Quick Start](https://prisma-idb.dev/docs/prisma-8/getting-started). For how the packages fit together, see [ARCHITECTURE.md](https://github.com/prisma-idb/prisma-idb/blob/main/packages/prisma-orm/docs/ARCHITECTURE.md).

## Lowered query identity

The adapter preserves the driver operation and adds `queryIdentity` when the query AST provides a serializable filter or sort specification. The identities are canonical strings. Sort identity preserves field priority as well as direction. The driver ignores this metadata; middleware uses it for cache identity.

An AST supplied by a custom query builder must describe the plan's filter and comparator closures, including those in range-split child scans. Missing or unsupported structured values leave the corresponding closure opaque. The runtime then prevents cache reuse for that closure. Middleware receives the lowered plan, rather than the original `ast`.

## License

MIT
