# `@prisma-idb/target-idb`

> Part of the [`@prisma-idb`](https://prisma-idb.dev/) driver stack for Prisma 8.

**target-idb** is the foundation layer. It defines the IDB target pack: store/index identity, DDL op factories, and the migration runner that applies schema changes idempotently on `IDBDatabase` open.

## Stack position

```
family-idb  (CLI / config)
client-idb  (ORM query builder)
runtime-idb (RuntimeCore)
adapter-idb (query AST → IDB plan)
driver-idb  (window.indexedDB wrapper)
target-idb  ← you are here (identity + migrations)
```

## Usage

Consumed internally by the rest of the `@prisma-idb` family. You generally do not install this package directly — use [`@prisma-idb/family-idb`](https://www.npmjs.com/package/@prisma-idb/family-idb) as your entry point.

## License

MIT
