# ADR 012 — Client Contract Subsetting

## Context

A syncing app has two databases running from the same domain: Postgres (or whatever the server uses) is the full schema; IndexedDB is always a subset. Some models are server-only (audit logs, internal jobs, anything with no reason to ever reach a browser). Some fields on an otherwise-synced model are server-only (password hashes, internal flags, anything sensitive or irrelevant to the client).

The old generator (`packages/generator`) solved this with `include`/`exclude` glob patterns in the generator config, resolved against the DMMF at codegen time (`parseGeneratorConfig.ts:94-148`). That's a coarse, model-only, string-matching mechanism — it can drop a whole model but can't drop one field off a model that's otherwise synced.

Discord discussion with Will Madden (2026-06-10) proposed the framework-native answer: _"define two contracts: the client's contract which is a subset of the backend contract… each extension may provide its own contract and migration graph and all extension contracts + application contract are aggregated into a whole on startup."_ That's the `extensionPacks`/contract-space aggregation mechanism (`vendor/prisma-next/docs/architecture docs/subsystems/6. Ecosystem Extensions & Packs.md`), and it's built for exactly this: one contract depending on another, loaded and validated together.

We're not using it as-is, though. Extension aggregation composes _independently authored_ contracts (app + Supabase + pgvector, each with their own `.prisma`/`.ts` source). Client/server subsetting is different: it's the _same_ domain model, viewed through two lenses. Maintaining two hand-authored schemas (`client.prisma` + `server.prisma`) reintroduces exactly the drift problem the framework's contract-space mechanism exists to prevent — a field renamed on one side and forgotten on the other fails silently until a sync payload doesn't decode.

## Decision

One schema, authored once, interpreted twice. Add IDB-family-owned attributes recognized by `family-idb`'s two authoring surfaces — `psl-interpreter.ts` (PSL) and `contract-builder.ts` (TS `defineContract`) — that mark a model or field as excluded from the _client_ projection:

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

```ts
// TS authoring surface (contract-builder.ts) — same semantics, ModelDef-level flag
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

This follows the namespaced-attribute pattern already established for extension packs (ADR 104), but it isn't a third-party extension namespace — `idb` is the _target family's own_ reserved namespace, parsed unconditionally by `family-idb`, the same way `@@map`/`@id`/`@relation` already are (`psl-interpreter.ts:118-140`).

### Two emitted contracts, two migration graphs

`family-idb`'s emit step runs the interpreter twice against the same parsed symbol table: once producing the full contract (today's behavior, unchanged — this _is_ the server-facing shape, or feeds whatever produces it), once producing the projected client contract with excluded models/fields removed. Each gets its own `ContractSpace` — its own `migrations/` directory, its own `headRef` — because they're genuinely different schemas with independent-but-related lifecycles (see ADR 014's migration-lifecycle note, deferred). `createAutoMigratingIdbClient` only ever sees the client contract space; it has no reason to know the server schema exists.

### Relation handling is ADR 013's problem

Excluding a model or field can leave dangling relations on models that survive. That cascading logic — which models/fields get transitively dropped, and why — is scoped entirely to ADR 013, so this ADR doesn't duplicate it.

### Split-package apps: a dedicated schema package, never frontend/backend depending on each other

A SvelteKit or Next.js app has one package straddling both sides, so "where does the schema live relative to its two consumers" is moot — it's just in the app. That stops being true the moment frontend and backend are separate packages (a SPA + API split, a mobile app + backend, anything with independent deploys). The dependency-direction reasoning from "Why not the extension-pack mechanism directly" applies here too, just one level up the stack: the schema source (which contains both the server-only members and the `@idb.exclude` markers) cannot live inside the backend package, because then the frontend package would have to depend on the backend package to reach it — pulling in server code, DB drivers, and anything else the backend ships, into a package that gets bundled for the browser. It can't live in the frontend package either, since the whole point of projection is that the frontend never sees the pre-exclusion schema.

The schema source lives in a **third package**, depended on by both, depended on by neither of them. That package owns the `.prisma`/TS schema and runs `family-idb`'s emit step (the same two-pass interpretation this ADR already specifies) as its own build step, publishing both outputs under one package name with two subpath exports:

```text
@myapp/schema/
  package.json
    "exports": {
      "./client": "./dist/client-contract-space.js",
      "./server": "./dist/server-contract.js"
    }
  src/
    schema.prisma          # source, both idb.exclude sides present
  dist/
    client-contract-space.js
    server-contract.js

frontend/package.json:  "@myapp/schema": "workspace:*"  → imports "@myapp/schema/client"
backend/package.json:   "@myapp/schema": "workspace:*"  → imports "@myapp/schema/server"
```

One package, one version number, over two separate packages (`@myapp/schema-client` + `@myapp/schema-server`): a version bump moves both contracts atomically. Two packages need external coordination (a changesets fixed group, or a build-time hash check) to guarantee the frontend's client contract and the backend's server-side DAG were emitted from the same schema commit — skew there is exactly the kind of bug that's silent until a sync payload doesn't decode or a `rootModel` reachability check the frontend never sees disagrees with what the backend built. A single package's `exports` map makes the same-version guarantee free instead of a process the team has to maintain.

This works identically whether the two consumers are workspace packages in one monorepo (`workspace:*`, resolved locally, no publish step) or genuinely separate repos (the schema package gets published to a registry, private or public, and both sides pin a version) — the package boundary is the same either way, only the resolution mechanism changes. `family-idb`'s emit CLI doesn't need new machinery for this: it already writes `ContractSpace` output to a configurable location, which is all "write into this package's `dist/`" requires.

`./server` never being importable from a bundler resolving for a browser target is a property of the app's bundler config (excluding the subpath, or the package declaring a `"browser"` exports condition that maps `./server` to an error/empty module), not something `family-idb` enforces — the emit step's only guarantee is that `client-contract-space.js` itself contains zero server-only models or fields to leak, regardless of what a misconfigured bundler manages to resolve.

## Why not the extension-pack mechanism directly

`extensionPacks` composes _forward_ — the app depends on and references extension models, never the reverse (`Ecosystem Extensions & Packs.md:336-357`, DAG-enforced, cycles rejected at load). A client/server split isn't a dependency relationship; the client contract isn't "extending" the server contract, it's a _projection_ of the same source. Modeling it as `extensionPacks` would either require the client to declare a dependency on the server contract (wrong direction — the client shouldn't need the server's package at all, including in the browser bundle) or the server to depend on the client (meaningless — the server has no gaps the client fills).

## Why not two hand-authored schemas

Considered and rejected per the Context section — no mechanism preventing drift, and every field addition requires remembering to update two files by hand. This is precisely the failure mode contract-first authoring exists to avoid everywhere else in the framework.

## Consequences

- **`@idb.exclude` / `@@idb.exclude` are new PSL and TS-builder surface**, owned entirely by `family-idb` — no upstream framework change needed, matches the namespaced-attribute pattern the framework already documents for exactly this kind of target-specific extension (ADR 104).
- **The server-facing contract is not this repo's concern to define the _shape_ of** — whatever produces it (a separate SQL family package, a hand-maintained Postgres contract, etc.) is out of scope here. What this ADR commits to is that `family-idb`'s interpreter can run in "client projection" mode against a schema that also declares server-only members, and won't choke on attributes it doesn't recognize as its own that a sibling family (e.g. `@@sql.something`) might introduce later.
- **Two `ContractSpace`s means two migration histories to reason about.** A field added server-side and marked `@idb.exclude` never touches the client's migration graph at all — no client migration, no client marker bump. A field added without the exclusion attribute needs both graphs to move (out of scope for this ADR — see ADR 014 for the coordination question, which Will explicitly deferred as unsolved: _"a server-side field addition needs to propagate to the local schema eventually, who owns that coordination?"_).
- **No runtime cost.** Projection happens once, at emit time (CLI), same as everything else in the Phase-7 migration design (`INDEX.md`'s "Authoring → bundling → applying are three separate stages" note). The browser never sees the full schema or the projection logic.
- **Split-package apps need a third package for the schema.** Not optional once frontend and backend are independently deployed packages — see the dedicated subsection above. This is a new packaging convention this repo is opinionated about (single package, two subpath exports, atomic versioning), not something left to each app to figure out.

## Related

- ADR 013 — FK Projection on Excluded Models (the cascading-exclusion logic this ADR defers to)
- ADR 104 (upstream) — PSL extension namespacing & syntax — the attribute pattern `@idb.exclude` follows
- `vendor/prisma-next/docs/architecture docs/subsystems/6. Ecosystem Extensions & Packs.md` — contract-space aggregation, considered and rejected as the direct mechanism
- `family-idb/src/core/psl-interpreter.ts` — PSL authoring surface, attribute parsing precedent (`@@map`, `@id`, `@relation`)
- `family-idb/src/core/contract-builder.ts` — TS authoring surface (`defineContract`)
- `packages/generator/src/helpers/parseGeneratorConfig.ts` — old generator's coarser include/exclude glob mechanism, the DX bar to match or beat
- Discord thread with Will Madden, 2026-06-10 — "define two contracts: the client's contract which is a subset of the backend contract"
