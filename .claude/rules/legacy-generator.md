---
description: "Legacy generator (packages/generator): code-block-writer patterns, regeneration, generator config."
paths: "packages/generator/**, tests/schema-gen/**, tests/schemas/**"
globs: "packages/generator/**, tests/schema-gen/**, tests/schemas/**"
alwaysApply: false
applyTo: "packages/generator/**,tests/schema-gen/**,tests/schemas/**"
---

# Legacy generator

`@prisma-idb/idb-client-generator` reads Prisma's DMMF and writes a typed IndexedDB client. It is stable and published; prefer fixes over new surface.

## Change the generator, then regenerate

- Client behavior lives in `packages/generator/src/fileCreators/<feature>/create.ts`. Never edit a generated client under `**/src/lib/prisma-idb/**`; a hook blocks it.
- After changing `packages/generator/src`, run `pnpm generate`. It rebuilds the generator and rewrites the committed clients in `apps/usage`, `apps/kanban-example` and `apps/benchmark`. Commit the regenerated output with the generator change. `pnpm test:generator-schema` generates its own fixtures under `tests/schema-gen`.
- To debug a generated client, read the output in `tests/schema-gen/tests/projection/generated/` or `apps/usage/src/lib/prisma-idb/`.

## Writing code with `code-block-writer`

- Use `writer.block(() => { ... })` for braces and `writer.indent(() => { ... })` for indentation. Never write `{`, `}`, `\t` or leading spaces by hand.
- Prefer `writer.writeLine(...)` over `writer.write("...\n")`.
- Split long output into several writer calls or helper functions.

```ts
writer.write("export function example() ").block(() => {
  writer.writeLine("const x = 1;");
  writer.write("if (x === 1) ").block(() => {
    writer.writeLine("console.log(x);");
  });
});
```

## How the generated client works

- IndexedDB can't run complex queries, so the client filters and sorts in memory with generated helpers such as `whereBoolFilter` and `orderByComparator` in `idb-utils.ts`.
- Validators are generated with Zod in `validators.ts` and run on both client and server.
- Sync uses an outbox on the client and a materialized changelog on the server. Every syncable record must trace back to the `rootModel` through foreign keys.
- Syncable models need a single client-generated id (`uuid` or `cuid`). Composite ids and autoincrement ids are not allowed for synced data.

Generator options in `schema.prisma`: `outboxSync` (boolean) enables sync, `rootModel` (string, required with `outboxSync`) anchors ownership, and `exclude` (string array) skips models such as auth tables.

## Checks

`pnpm test:generator-schema` for generation and types, `pnpm test:generator-client` for the browser client, `pnpm test:generator-sync` for full-stack sync (needs PostgreSQL).
