# `@prisma-idb/client-idb`

> Part of the [`@prisma-idb`](https://prisma-idb.dev/) driver stack for Prisma 8.

**client-idb** is the ORM layer — the `idbOrm` typed query builder that end users and framework integrations call directly.

## Stack position

```
family-idb  (CLI / config)
client-idb  ← you are here (ORM query builder)
runtime-idb (RuntimeCore)
adapter-idb (query AST → IDB plan)
driver-idb  (window.indexedDB wrapper)
target-idb  (identity + migrations)
```

## Usage

Consumed internally by [`@prisma-idb/family-idb`](https://www.npmjs.com/package/@prisma-idb/family-idb). You generally do not install this package directly — use `family-idb` as your entry point.

## License

MIT
