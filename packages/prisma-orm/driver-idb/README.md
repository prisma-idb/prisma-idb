# `@prisma-idb/driver-idb`

> Part of the [`@prisma-idb`](https://prisma-idb.dev/) driver stack for Prisma 8.

**driver-idb** wraps the raw `window.indexedDB` API and exposes typed read/write primitives to the execution stack above it.

## Stack position

```
family-idb  (CLI / config)
client-idb  (ORM query builder)
runtime-idb (RuntimeCore)
adapter-idb (query AST → IDB plan)
driver-idb  ← you are here (window.indexedDB wrapper)
target-idb  (identity + migrations)
```

## Usage

Consumed internally by the rest of the `@prisma-idb` family. You generally do not install this package directly — use [`@prisma-idb/family-idb`](https://www.npmjs.com/package/@prisma-idb/family-idb) as your entry point.

## License

MIT
