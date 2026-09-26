# ADR 012: Client contract subsetting

- **Status:** Accepted
- **Date:** 2026-08-07
- **Area:** Contract authoring

## Summary

A syncing app writes its schema once. The attributes `@idb.exclude` (on a field) and `@@idb.exclude` (on a model) mark what stays on the server. Two configs read the same schema file:

- **The IndexedDB config** produces the client contract, with excluded models and fields removed.
- **The server config** (for example Postgres) produces the full contract, and ignores the exclusion attributes.

Each contract has its own migration history. The browser never sees the server-only parts.

## Context

A syncing app has two databases for the same data. The server database, for example Postgres, holds the full schema. IndexedDB in the browser holds a subset:

- **Some models are server-only**, such as audit logs or internal jobs.
- **Some fields on synced models are server-only**, such as password hashes or internal flags.

The old generator (`packages/generator`) handled this with `include`/`exclude` glob patterns in its config. Those could drop a whole model, but not a single field from a model that is otherwise synced.

An upstream maintainer suggested defining two contracts, with the client's contract a subset of the server's, using the framework's extension-pack aggregation. That mechanism composes separately authored contracts, such as an app plus a pgvector extension, each with its own schema source. Client and server are different: they are the same data model seen two ways. Keeping two hand-written schemas would let them drift apart. A field renamed on one side and forgotten on the other would fail silently until a sync payload didn't decode.

## Decision

Write one schema, and mark server-only members with IndexedDB-family attributes:

```prisma
model Workout {
  id     String @id @default(uuid(7))
  name   String
  secret String @idb.exclude   // server-only field
  userId String
}

model AuditLog {
  id String @id
  @@idb.exclude                 // server-only model
}
```

The TypeScript contract builder has the same options:

```ts
defineContract({
  models: {
    Workout: {
      store: "workout",
      key: "id",
      fields: { id: "String", name: "String", secret: "String", userId: "String" },
      excludeFields: ["secret"],
    },
    AuditLog: { store: "auditLog", key: "id", fields: { id: "String" }, exclude: true },
  },
});
```

The attributes use the namespaced-attribute syntax from upstream ADR 104. `idb` is the IndexedDB family's own namespace, and `family-idb` always parses it, like `@id` or `@relation`.

### Two contracts, two migration histories

`apps/prisma-orm-kanban-example` shows the setup:

- **`prisma.config.ts`** uses the IndexedDB family. It reads `schema.prisma` with `prismaIdbContract(path, { projection: "client" })` and emits the client contract without the excluded members. Its migrations live in `migrations/`.
- **`prisma.config.postgres.ts`** uses the Postgres family, through `defineConfig` from `@prisma-idb/sync-server/postgres`. It reads the same `schema.prisma`, strips the `idb` attributes in memory (the SQL parser would otherwise reject the unknown namespace), and emits the full server contract. Its migrations live in `migrations-postgres/`.

The two contracts are different schemas with related but separate lifecycles, so each has its own migration history. `createAutoMigratingIdbClient` only ever sees the client's.

### Relations to excluded models

Excluding a model can leave relations on surviving models pointing at it. [ADR 013](ADR%20013%20-%20FK%20Projection%20on%20Excluded%20Models.md) covers what happens to them.

### Apps with separate frontend and backend packages

In a SvelteKit or Next.js app, one package holds both sides, so the schema simply lives in the app. When the frontend and backend are separate packages, the schema can live in neither:

- **Not in the backend package.** The frontend would have to depend on the backend to reach it, pulling server code and database drivers into a browser bundle.
- **Not in the frontend package.** The frontend must never see the schema before exclusion.

Put the schema in a third package that both depend on. It emits both contracts and exposes them as two subpath exports of one package:

```text
@myapp/schema/
  package.json
    "exports": {
      "./client": "./dist/client-contract-space.js",
      "./server": "./dist/server-contract.js"
    }
  src/
    schema.prisma          # the one source, including idb.exclude markers

frontend/package.json:  "@myapp/schema": "workspace:*"  → imports "@myapp/schema/client"
backend/package.json:   "@myapp/schema": "workspace:*"  → imports "@myapp/schema/server"
```

Use one package rather than two (`@myapp/schema-client` and `@myapp/schema-server`). One version number then guarantees that both contracts came from the same schema. With two packages, the team would need extra process to keep them in step, and a mismatch would fail silently.

The same layout works in a monorepo (`workspace:*`) or across repos (publish the schema package to a registry).

Keeping `./server` out of the browser bundle is the app's bundler configuration's job, for example with a `"browser"` export condition. `family-idb` only guarantees that the client output contains no server-only models or fields.

## Alternatives considered

- **The extension-pack mechanism.** Extension packs compose in one direction: the app depends on extension models, never the reverse, and cycles are rejected. The client contract isn't an extension of the server's. It's a view of the same source. Modelling it as an extension would make the client depend on the server contract (the wrong direction, pulling server code into the browser), or the server depend on the client (meaningless). Rejected.
- **Two hand-written schemas.** Nothing stops them drifting apart, and every change has to be made twice. Rejected.

## Consequences

- **`@idb.exclude` and `@@idb.exclude` are new schema syntax**, owned by `family-idb`. No upstream change was needed.
- **This repo doesn't define the server contract.** The server family produces it. What this ADR guarantees is that `family-idb` can read a schema that also contains server-only members, and produce a correct client contract from it.
- **Two migration histories.** A field added on the server and marked `@idb.exclude` never touches the client's migrations. A field added without the exclusion needs migrations on both sides. Who coordinates those is an open question, raised with upstream and not yet solved.
- **No runtime cost.** The client contract is produced at build time. The browser never sees the full schema or the exclusion logic.
- **Apps with separate frontend and backend packages need a third package for the schema**, laid out as above.

## Related

- [ADR 013](ADR%20013%20-%20FK%20Projection%20on%20Excluded%20Models.md): relations that point at excluded models.
- [ADR 014](ADR%20014%20-%20Sync%20Ownership%20DAG.md): uses the client contract to decide which models need an ownership path.
- `family-idb/src/core/psl-interpreter.ts` and `contract-builder.ts`: where the exclusion attributes are read.
- `apps/prisma-orm-kanban-example/prisma.config.ts` and `prisma.config.postgres.ts`: the two configs over one schema.
