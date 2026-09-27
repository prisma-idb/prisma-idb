# `@prisma-idb/family-idb`

The IndexedDB family for Prisma 8, used at build time. It reads your Prisma schema into an IndexedDB contract, plugs IndexedDB into the `prisma` CLI, and provides the `prisma-idb` CLI for migrations.

```bash
npm install --save-dev @prisma-idb/family-idb
```

## The `prisma-idb` CLI

IndexedDB only exists in the browser, so three migration jobs need their own commands:

| Command                               | Does                                                                            |
| ------------------------------------- | ------------------------------------------------------------------------------- |
| `prisma-idb migration plan`           | Plans the next migration from the newest one on disk. Warns if it deletes data. |
| `prisma-idb migration contract-space` | Bundles the migrations into a module the browser imports.                       |
| `prisma-idb migration preflight`      | Applies every migration to an in-memory IndexedDB to check that it runs.        |

All three read `prisma.config.ts`. See [Migrations](https://prisma-idb.dev/docs/prisma-8/migrations).

## Entry points

| Import                                | Contains                                                             |
| ------------------------------------- | -------------------------------------------------------------------- |
| `@prisma-idb/family-idb/control`      | The family descriptor for `prisma.config.ts`.                        |
| `@prisma-idb/family-idb/config-types` | `defineConfig` for `prisma.config.ts`.                               |
| `@prisma-idb/family-idb/contract-psl` | `prismaIdbContract(path, { projection })`: reads a `.prisma` schema. |
| `@prisma-idb/family-idb/contract-ts`  | `defineContract()`: write a contract in TypeScript instead.          |
| `@prisma-idb/family-idb/cli`          | The `prisma-idb` commands, for embedding in another CLI.             |

## Documentation

- [Quick Start](https://prisma-idb.dev/docs/prisma-8/getting-started)
- [Schema & Config](https://prisma-idb.dev/docs/prisma-8/schema)
- [Migrations](https://prisma-idb.dev/docs/prisma-8/migrations)

## License

MIT
