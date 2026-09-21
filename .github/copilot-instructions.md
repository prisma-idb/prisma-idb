# Prisma IndexedDB Client Generator Instructions

You are working on a Prisma generator that creates a familiar, type-safe client for IndexedDB with built-in bidirectional synchronization.

## Big Picture Architecture

- **Generator-Centric**: Most core logic resides in `packages/generator`. If you need to change client behavior, edit the generator's `fileCreators`.
- **Sync Flow**: Uses an **Outbox Pattern** on the client and a **Changelog Materialization** on the server.
- **Ownership Invariants**: Syncability is gated by an ownership DAG. Every syncable record must be traceable to a `rootModel` (e.g., `User`) via a foreign key or similar ownership fields. Refer to `todo.md` for the 4 core invariants.
- **Client-Side IDs**: All syncable models **must** use a single client-generated id field (`uuid`, `cuid`). Composite `@id` keys and auto-incrementing IDs are strictly forbidden for syncable data.

## Critical Workflows

- **Regeneration**: After modifying any code in `packages/generator/src`, you MUST run:
  ```bash
  pnpm generate
  ```
  This updates the generated clients in `apps/usage`, `apps/kanban-example`, and the `tests/generated` folder.
- **Testing**:
  - `pnpm test:generator-schema`: Validates generator output against snapshots in `tests/generator.test.ts`.
  - `pnpm test:generator-client`: Runs Playwright/Vitest tests in `apps/usage` to verify the generated client API.
  - `pnpm test:generator-sync`: Runs full-stack sync tests in `apps/kanban-example`.
- **Debugging**: If the generated client is behaving unexpectedly, inspect the files in `tests/generated/prisma-idb/client/`.

## Coding Patterns & Conventions

- **Code Generation**: All generated code must use `code-block-writer`.
  - Pattern: `packages/generator/src/fileCreators/{feature}/create.ts`
  - **Best Practices**:
    - Use `writer.block(() => { ... })` for curly braces and `writer.indent(() => { ... })` for indentation. Never write `{` or `}` manually for blocks.
    - Avoid manual `\t` or spaces for indentation.
    - Split long or complex code sections into multiple `writer` method calls or separate helper functions for readability.
    - Prefer `writer.writeLine(...)` over `writer.write("...\n")`.
    - Example:
      ```typescript
      writer.write("export function example() ").block(() => {
        writer.writeLine("const x = 1;");
        writer.write("if (x === 1) ").block(() => {
          writer.writeLine("console.log(x);");
        });
      });
      ```
- **Filters & Comparators**: IndexedDB doesn't support complex querying. We generate in-memory filters (e.g., `whereBoolFilter`) and comparators (e.g., `orderByComparator`) in `idb-utils.ts`.
- **Validation**: The generator uses **Zod** for schema validation both on the client and server. Validators are generated in `validators.ts`.
- **Prisma DMMF**: The generator relies on Prisma's DMMF. Data types are mapped from Prisma schema types to TypeScript/IDB equivalents.

## Key Directories

- `packages/generator/src/fileCreators`: Logic for writing different parts of the client.
- `apps/usage/src/lib/prisma-idb`: Example location of a generated client.
- `tests/schemas`: Prisma schemas used for testing various generator scenarios.

## Generator Configuration

When adding or modifying the generator in a `schema.prisma`:

- `outboxSync`: (boolean) Enables the bidirectional sync system.
- `rootModel`: (string) The anchor model for the ownership DAG (required if `outboxSync` is true).
- `exclude`: (string[]) Models to skip during generation (usually auth or log models).
