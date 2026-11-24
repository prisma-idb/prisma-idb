# `@prisma-idb/family-idb`

The IndexedDB family for Prisma 8, used at build time. It reads your Prisma schema into an IndexedDB contract, plugs IndexedDB into the `prisma` CLI, and provides the `prisma-idb` CLI for migrations.

```bash
npm install --save-dev @prisma-idb/family-idb
```

## The `prisma-idb` CLI

IndexedDB only exists in the browser, so three migration jobs need their own commands:

| Command                               | Does                                                                                                                           |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `prisma-idb migration plan`           | Plans the next migration from the newest one on disk. Warns if it deletes data.                                                |
| `prisma-idb migration contract-space` | Bundles the migrations into a module the browser imports.                                                                      |
| `prisma-idb migration preflight`      | Replays migrations in memory, verifies the schema against the head snapshot, and checks that the emitted contract is the head. |

Pass `--rename Model.old:Model.new` to preserve a renamed field’s values. Use `--backfill Model.field` and `--convert Model.field` to supply a transform in the migration file.

All three commands read `prisma.config.ts`. See [Migrations](https://prisma-idb.dev/docs/prisma-8/migrations).

## Entry points

| Import                                | Contains                                                             |
| ------------------------------------- | -------------------------------------------------------------------- |
| `@prisma-idb/family-idb/control`      | The family descriptor for `prisma.config.ts`.                        |
| `@prisma-idb/family-idb/config-types` | `defineConfig` for `prisma.config.ts`.                               |
| `@prisma-idb/family-idb/contract-psl` | `prismaIdbContract(path, { projection })`: reads a `.prisma` schema. |
| `@prisma-idb/family-idb/contract-ts`  | `defineContract()`: write a contract in TypeScript instead.          |
| `@prisma-idb/family-idb/cli`          | The `prisma-idb` commands, for embedding in another CLI.             |

## Contract authoring

Author a contract in PSL with `prismaIdbContract(path, options?)`, or in TypeScript with `defineContract(input, options?)`. Both surfaces lower into one internal `IdbContractDefinition` and use the same validation and hash builder. Equivalent definitions produce the same storage, profile, and execution hashes.

For Prisma VS Code extension hints, put `// use prisma-8` on the first line of the `.prisma` file, before other comments. This selects the Prisma 8 language server, which uses the project's local `prisma` CLI and `prisma.config.ts` to discover IDB scalar types, attribute signatures, hover descriptions, and diagnostics. Without the directive, the extension uses the legacy server. Run **Prisma: Restart Language Server** after changing the directive or rebuilding workspace packages. See [Editor Setup](https://prisma-idb.dev/docs/prisma-8/editor-setup).

TypeScript models use a `defaults` map for create-time literals, `autoincrement()`, `now()`, and generated values written as `{ onCreate: gen.uuid(7) }` or `{ onCreate: gen.now(), onUpdate: gen.now() }`. `gen` has one helper per generator function, matching PSL `@onCreate(...)` and `@onUpdate(...)`. Import the helpers from `@prisma-idb/family-idb/contract-ts`. The older `fieldDefaults` map only supplies values for the `setDefault` referential action.

PSL `DateTime` fields also accept tagged defaults, such as ``startsAt DateTime @default(date`2024-01-01T09:30:00Z`)``. The `date` tag takes an ISO 8601 instant with a time and a UTC offset, as in upstream Prisma's MongoDB target. Each create gets its own native `Date`. Text that names no instant, such as `2024-02-30T00:00:00Z`, a calendar date with no time or a time without an offset, is rejected, as is a tagged default on a field that is not `DateTime`. Explicit values, including `null` on nullable fields, take precedence. Tagged defaults apply on create only; they do not supply `setDefault` relation values or automatic migration backfills.

Both surfaces index each foreign-key field by default. TypeScript relations can set `index: false` to opt out. Existing TypeScript contracts may get a new `storageHash` and need an index migration. See [Adopt Foreign-Key Indexes](https://prisma-idb.dev/docs/prisma-8/foreign-key-indexes).

Invalid shared definitions throw `IdbContractError` from the TypeScript entry point. Its `diagnostics` array lists `IDB_*` codes, messages, and definition paths. PSL reports the corresponding diagnostics with source spans. See [Contract Authoring](https://prisma-idb.dev/docs/prisma-8/contract-authoring) for attribute mappings, defaults, indexes, and diagnostic codes.

## Documentation

- [Quick Start](https://prisma-idb.dev/docs/prisma-8/getting-started)
- [Schema & Config](https://prisma-idb.dev/docs/prisma-8/schema)
- [Migrations](https://prisma-idb.dev/docs/prisma-8/migrations)

## License

MIT

## Emit a typed contract

Run `prisma-idb contract emit` for the browser config, or
`prisma-idb contract emit --config prisma.config.postgres.ts` for a SQL config.
The command uses Prisma's emission operation and publishes `<name>.json`,
`<name>.d.ts`, and `<name>.runtime.ts` together. A failed publication restores
previous artifacts. `--output <directory>` overrides the configured JSON path
and writes `contract.*` in that directory.

Import the default export from `./contract.runtime` (or your configured basename)
to pass the generated contract directly to runtime APIs without a cast. The
runtime module also re-exports the generated types. JSON and declarations remain
available for database commands and migration tooling.
