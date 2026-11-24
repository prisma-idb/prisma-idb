# ADR 028: Nested relation criteria must apply

- **Status:** Accepted
- **Date:** 2026-11-24
- **Area:** Nested ORM writes

Validate all nested relation criteria before executing a write. Each explicit criterion must produce a filter. When the row being written holds the foreign key, `connect()` requires one criterion and `disconnect()` requires zero.

[Upstream Prisma SQL](https://github.com/prisma/orm/blob/17385f2d86eefa3783e86d94534168a224806c0a/packages/3-extensions/sql-orm-client/src/mutation-graph/nested-mutations.ts#L124-L135) clears a locally held foreign key on disconnect without applying any supplied criteria. Its [connect path](https://github.com/prisma/orm/blob/17385f2d86eefa3783e86d94534168a224806c0a/packages/3-extensions/sql-orm-client/src/mutation-graph/nested-mutations.ts#L225-L233) uses the first criterion. The IndexedDB client rejects those unused inputs so a caller can tell when the conditions they supplied would have no effect.

Use `disconnect()` or `disconnect([])` to detach all related rows. Use one criterion to connect to the row referenced by a locally held foreign key. For child-owned foreign keys, each supplied criterion can match several children.

Matching upstream's first-entry and unconditional behavior would silently allow a write that ignores some of the caller's conditions. Applying a filter to a locally held disconnect would give the same call a different meaning in the two clients. Rejecting the supplied criteria makes the caller choose an explicit operation.
