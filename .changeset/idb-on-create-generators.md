---
"@prisma-idb/family-idb": minor
"@prisma-idb/target-idb": minor
"@prisma-idb/client-idb": minor
"@prisma-idb/sync-extension-idb": patch
---

PSL schemas take `@onCreate(fn())` and `@onUpdate(fn())`, as in upstream Prisma 8. The client runs the generator function when a record is created or updated. The functions are `now()` on `DateTime` fields, and `uuid()`, `uuid(7)`, `cuid(2)`, `ulid()`, `nanoid(size?)` and `ksuid()` on `String` fields. Generated values may now sit on optional fields; an explicit `null` still wins.

Breaking: Prisma 8 removed some Prisma 6 forms, and `contract emit` now refuses them, naming what to write instead:

- `@default(uuid())` and `@default(cuid())`: write `@onCreate(uuid())` and `@onCreate(cuid(2))` (`PSL_GENERATOR_IN_DEFAULT`).
- `@updatedAt` and the `temporal.updatedAt()` type: write `DateTime @onCreate(now()) @onUpdate(now())`.

TypeScript contracts write the same generators with upstream's `gen` helpers, from `@prisma-idb/family-idb/contract-ts`: `defaults: { id: { onCreate: gen.uuid(7) }, updatedAt: { onCreate: gen.now(), onUpdate: gen.now() } }`. Each call resolves through the same functions as PSL. Breaking: `uuidv4()`, `uuidv7()`, `cuid2()` and `updatedAt()` are removed; write `{ onCreate: gen.uuid() }`, `{ onCreate: gen.uuid(7) }`, `{ onCreate: gen.cuid(2) }` and `{ onCreate: gen.now(), onUpdate: gen.now() }`. `now()` and `autoincrement()` are unchanged.

A primary key never changes, so any `@onUpdate(...)` on a key field is refused. The code `IDB_TEMPORAL_UPDATED_AT_ON_KEY_FIELD` is renamed `IDB_ON_UPDATE_ON_KEY_FIELD`.

The rewritten schema or contract emits the same contract, so existing databases need no migration. A schema shared with a SQL sync server now means the same thing on both sides. `@default(now())` and `@default(autoincrement())` are unchanged.
