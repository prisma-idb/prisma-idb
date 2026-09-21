# `@prisma-idb/runtime-idb`

> Part of the [`@prisma-idb`](https://prisma-idb.dev/) driver stack — IndexedDB for [Prisma 8](https://www.prisma.io/blog/prisma-next-call-for-extension-authors).

**runtime-idb** is the `RuntimeCore` subclass that wires together the adapter and driver into a complete Prisma 8 runtime.

## Stack position

```
family-idb  (CLI / config)
client-idb  (ORM query builder)
runtime-idb ← you are here (RuntimeCore)
adapter-idb (query AST → IDB plan)
driver-idb  (window.indexedDB wrapper)
target-idb  (identity + migrations)
```

## Usage

Consumed internally by the rest of the `@prisma-idb` family. You generally do not install this package directly — use [`@prisma-idb/family-idb`](https://www.npmjs.com/package/@prisma-idb/family-idb) as your entry point.

## License

MIT
