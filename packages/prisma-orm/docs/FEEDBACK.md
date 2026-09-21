# Feedback on the Prisma 8 IndexedDB target

First — thanks for putting this together.

What follows is one round of architectural feedback. The headline issue is that the migration system in this PR has drifted significantly from Prisma 8's design, and as a result it's hitting problems the framework already solves. Group A walks through the drift; Group B is independent cleanups.

---

## Group A — The migration design has drifted from Prisma 8

These three issues are all the same underlying decision viewed from different angles. They're easiest to follow if I walk you through how the framework's migration system works first, then describe what this PR does instead, then explain the gap.

### 1. The framework's migration package layer is missing

#### How the framework's migration system works

When a developer edits their contract and runs `prisma-idb migration plan`, the framework writes a directory under `migrations/app/`:

```
migrations/app/20260601T1200_add_user_email/
├── migration.json      # metadata, includes a content-hash of ops.json
├── ops.json            # the list of operations to apply (canonical, content-addressed)
├── end-contract.json   # the contract the database is in *after* this migration applies
└── migration.ts        # human-editable TypeScript source
```

Two things in this package matter for everything that follows:

- **`ops.json`** is the list of operations the runner applies to move the database forward by one step. Content-addressed; `migrationHash` is computed over it.
- **`end-contract.json`** is a snapshot of the contract the database is in _after_ this migration applies. The framework never derives schema state by replaying operations — it just reads the `end-contract.json` from the package whose hash matches the database's current marker.

`migration.ts` is the _authoring surface_ — it's not what the runner reads. When the planner detects something it can't generate automatically (a backfill, a rename), it writes a scaffold containing `placeholder(...)` calls. The developer replaces those with real query closures, then runs `node migrations/app/.../migration.ts`. That run is called "self-emit" — it regenerates `ops.json`, recomputes `migrationHash`, and re-snapshots `end-contract.json`. After that, the next `migrate` picks up the updated `ops.json`.

At apply time the runner reads each pending package's `ops.json`, applies the operations to the database, and updates the marker row to the package's `migrationHash`. The marker is the authoritative answer to "where is this database in the migration chain"; the matching package's `end-contract.json` is the authoritative answer to "what does the contract look like right now."

#### What this PR does

There is no migration package. There is no `ops.json`, `end-contract.json`, no `migrationHash`. There is no `migrations/` directory in `apps/prisma-orm-usage/`. The `migration new` command writes a single standalone `.ts` file with operations rendered into it — but no companion files, and no `MigrationCLI.run(...)` shim at the bottom — so even if a developer edits it, there's no mechanism to compile that edit into something the runner reads.

Both apply paths skip the package layer entirely and recompute operations fresh from the contract:

- **CLI path** (`prisma-next db update`): reads the current schema from the manifest, reads the new contract, calls the planner to diff them, applies the result, writes the new schema into the manifest.
- **Browser path** (`createAutoMigratingIdbClient`): opens the live IDB, introspects what stores and indexes it currently has, calls the planner to diff that against the new contract, applies the result.

The contract is the only durable input. There's no on-disk record of _how_ the database got from where it was to where it is — just the destination it's currently at.

#### Why this matters

Four consequences, in increasing order of severity:

1. **Backfills can't run.** In the framework, a backfill is a `dataTransform` operation that lives inside `ops.json`. It gets there because the planner emitted a `placeholder(...)` into `migration.ts`, a developer filled in the closures, and self-emit wrote the resulting operation into `ops.json`. With no `ops.json`, there's no place to record a backfill. ADR 008 lists data-transform migrations as a Path B capability, but the plumbing to deliver them isn't there.

2. **Renames are unrepresentable.** Same reason. In the framework, you can hand-edit `migration.ts` to replace a planner-emitted drop+add with a `rawSql("ALTER TABLE ... RENAME COLUMN ...")` operation, then self-emit. With no `migration.ts → ops.json` pipeline, that hook doesn't exist either. A rename will always wipe the user's data.

3. **No integrity check between authoring and apply.** The framework's `migrationHash` catches the case where someone edited `migration.ts` and forgot to self-emit, or where `ops.json` itself was tampered with. This PR has no equivalent — a developer could edit the generated `.ts` file, commit the edit, and have no signal anywhere that their edit will not actually run.

4. **No reviewable history.** When a user opens an old version of the app for the first time in a year, the framework applies each missing migration's `ops.json` in sequence to bring the database forward. Every step is named, hashed, and inspectable. This PR computes one combined diff and applies it as one transaction. That works for pure additive DDL, but it means you can never: review what migrations ran when, run a per-migration backfill in its correct slot, or detect that a previously-applied migration has been edited since.

#### What to change

Adopt the framework's package layout, and split the CLI/browser responsibilities cleanly:

- `prisma-next migration new` (or `migration plan`) writes a directory (`migrations/app/<timestamp>_<slug>/`) with all four files, not a single `.ts`. The `.ts` ends with the same `MigrationCLI.run(import.meta.url, M)` shim other targets use, so it can self-emit `ops.json` and re-snapshot `end-contract.json`.
- The DDL op factories you've already built (`createObjectStoreOp`, `createIndexOp`, `dropObjectStoreOp`, `dropIndexOp`) become the operations that get serialized into `ops.json`. Nothing about the IDB-specific logic changes — they're just stored as data on disk rather than recomputed at apply time.
- **`db update` should refuse to run against an IDB target, with a meaningful error.** In a SQL target the CLI connects to a live database and applies migrations to it. IndexedDB only exists in the browser; the CLI runs in Node; there is no database for the CLI to apply anything to. What `db update` does in your PR today is just "plan, dry-run against `fake-indexeddb`, rewrite the manifest" — none of which is applying a migration to any real database. The framework defines the CLI surface, so you can't remove the command, but the IDB target's runner can return a structured error along the lines of: _"IndexedDB migrations cannot be applied from the CLI — IndexedDB only exists in the browser. Migrations apply automatically the next time a user opens the app with `createAutoMigratingIdbClient`. Run `prisma-next migration preflight` to validate that the migration chain applies cleanly before deploying."_ Authoring stays in `migration new` / `migration plan`; validation lives in `migration preflight` (see #7).
- The browser is the actual apply path. `createAutoMigratingIdbClient` walks `contractSpace.migrations` from the marker hash to `contractSpace.headRef.hash` and applies each pending package's `ops.json` in sequence inside a single `upgradeneeded` callback. The integer `idbVersion` still triggers the upgrade — that part stays. What changes is what runs inside.

The IDB-specific work you've already done (two-phase marker write, `keyPath`/`autoIncrement` guards, well-ordered schema diff) all stays — it just lives inside one step of the chain rather than being the whole story.

#### "But the browser can't read files from disk"

This is the obvious objection, and the answer is the same answer the framework already uses for extension-contributed migrations today.

Take a look at how PostGIS its baseline msurfacesigration. The extension's migration package lives on disk in its own source tree at `packages/3-extensions/postgis/migrations/20260601T0000_install_postgis_extension/`, the same four-file layout described above. Its control descriptor then pulls the artefacts in via JSON imports:

```ts
// packages/3-extensions/postgis/src/exports/control.ts (excerpt)
import { contractSpaceFromJson } from "@prisma-next/migration-tools/spaces";
import baselineMetadata from "../../migrations/20260601T0000_install_postgis_extension/migration.json" with { type: "json" };
import baselineOps from "../../migrations/20260601T0000_install_postgis_extension/ops.json" with { type: "json" };
import headRef from "../../migrations/refs/head.json" with { type: "json" };
import contractJson from "../contract.json" with { type: "json" };

const postgisContractSpace = contractSpaceFromJson<Contract<SqlStorage>>({
  contractJson,
  migrations: [{ dirName: "...", metadata: baselineMetadata, ops: baselineOps }],
  headRef,
});
```

The on-disk files are the canonical authoring surface. The bundler resolves the JSON imports at build time, inlines the contents into the published JavaScript, and a consuming application receives the contract space as an **in-memory `ContractSpace<Contract>` value** — no filesystem access required at runtime. This is how every extension that contributes migrations works today.

User-authored IDB migrations should use the same mechanism. The shape is already defined: `ContractSpace<TContract>` from `@prisma-next/framework-components/control` carries `{ contractJson, migrations, headRef }`, which is everything the runtime needs:

- The CLI (`prisma-next migration new`) writes migration packages to disk in the user's source tree at `migrations/app/<ts>_<slug>/`. Same shape as every other target.
- A generated module (e.g. `src/lib/prisma/contract-space.generated.ts`) JSON-imports each `migration.json` + `ops.json` and assembles them into a `ContractSpace` via the existing `contractSpaceFromJson` helper.
- The user's `createAutoMigratingIdbClient` call accepts that contract space directly — `contractJson` is already inside it:

  ```ts
  import contractSpace from "./prisma/contract-space.generated";

  const db = await createAutoMigratingIdbClient({
    contractSpace,
    dbName: "my-app",
  });
  ```

- The runtime walks the in-memory `contractSpace.migrations` from the user's marker hash to `contractSpace.headRef.hash`, applying each package's `ops.json` inside a single `upgradeneeded` callback.

Meanwhile the CLI, which runs in Node and can read files directly, walks the same on-disk migration directory without needing the generated module. Both paths apply the same content-addressed operations from the same source — one reads from disk, the other from bundled memory. No new framework concepts are required; this is identical to how extension contract spaces have always worked.

---

### 2. Migration planning should happen at design time, not in the browser

This is the same drift as #1, viewed from the planner side.

#### How things work today

The planner is imported by `auto-migrate.ts` and ships to the browser. So does the IDB introspection code. Every time a user opens the app at a new contract version, _their browser_ computes the migration by:

1. Asking IndexedDB what stores and indexes currently exist.
2. Comparing that to the contract.
3. Generating DDL ops to bridge the gap.

That means every Chrome, Firefox, and Safari user is independently computing the migration, using browser-specific IDB introspection results as input.

#### Why this is a problem

The IDB spec leaves room for browsers to disagree on small things. What exactly does `IDBObjectStore.keyPath` return when it's a compound key — an array, a comma-separated string? Are `unique` and `multiEntry` always present on `IDBIndex`, or sometimes undefined? Different browsers (and `fake-indexeddb` in your tests) can give subtly different answers, and any divergence means the planner produces different DDL for the same contract pair on different browsers. That kind of bug is invisible in CI (everything uses the same `fake-indexeddb`) and shows up months later as a single user on Safari with a corrupted database.

There's also a bundle-size cost: the planner, the diff function, and the introspection code all ship to every client that uses your library, when none of it needs to run there.

#### What to change

Move planning to design time, exactly as #1 prescribes: `prisma-idb migration plan` produces `ops.json` once in the CLI, the bundled `ContractSpace` carries the resulting packages to the browser, and the browser-side runtime just applies them. The planner and the introspection code don't ship to the browser at all.

---

### 3. The manifest shouldn't exist

This is the same drift again, viewed from the manifest side. Once Group A is in place, every field the manifest carries is already covered by something the framework already has — and the file can go away entirely.

#### What the manifest currently holds

```json
{
  "version": 1,
  "idbVersion": 1,
  "schema": { "stores": { ... full schema description ... } },
  "marker": { "storageHash": "...", "profileHash": "...", ... }
}
```

Walk through each field:

- **`schema.stores`** — duplicates `end-contract.json`. Every Prisma 8 migration package already carries `end-contract.json`: the precise snapshot of the contract the database is in after that migration applies. The framework reads it directly whenever it needs to know "what does the database look like right now" — find the migration package whose hash matches the marker, read its `end-contract.json`. No replay, no reconstruction, no derivation. The manifest's `schema.stores` exists in your PR because `executeAcrossSpaces` has no migration packages to read from, so when the planner needs the prior contract, the manifest is the only place to look. You've reinvented `end-contract.json`, less consistently and in a separate file that has to be kept in sync by hand.

- **`marker`** — duplicates the in-database marker store. The framework's standard model is that the marker lives in the database, not in a separate file. Your runner already writes the marker into the `_prisma_next_marker` object store in IDB. The manifest's copy exists because `db sign` / `db verify` / `db update` wanted to read or write it from the CLI — but those commands all hit the same wall for IDB (the CLI runs in Node; IndexedDB only exists in the browser; the CLI can't read or write the in-database marker), so they should refuse with structured errors rather than read a stale shadow file. Once that happens, the manifest's marker copy has nothing to do.

- **`idbVersion`** — doesn't need to be tracked anywhere. The integer is purely IDB's local trigger mechanism; it carries no semantic information (different browsers happily sit at different integer versions for the same content hash). The browser can compute the next version it needs at runtime by reading `db.version + 1` from the open connection. Storing it in a manifest is only useful if some external process needs to predict it, and nothing in the new design does.

- **`version`** — the manifest's file-format version. Only meaningful if the manifest itself exists.

#### The flow without a manifest

The browser-side migration loop reduces to:

1. Open the DB with no version — gets a connection at whatever version exists locally.
2. Read the marker from `_prisma_next_marker`. (Null on a brand-new database.)
3. If the marker hash equals `contractSpace.headRef.hash`, return the connection; we're up to date.
4. Otherwise, compute the chain of pending packages from the marker hash to `headRef.hash`.
5. Close the connection. Reopen with `db.version + 1` to fire `upgradeneeded`.
6. Inside `upgradeneeded`, apply each pending package's `ops.json` in sequence — your existing schema-diff ordering, just from `ops.json` instead of from a fresh planner run.
7. After `onsuccess`, write the new marker to `headRef.hash` in a separate `readwrite` transaction (your existing two-phase pattern).

The marker is the only authoritative position record. The head ref lives in `migrations/refs/head.json` (which is already bundled into `contractSpace.headRef` per the framework's contract-space layout). The chain lives in `contractSpace.migrations`. The integer is a runtime-computed trigger.

#### What to change

Delete `prisma-idb.manifest.json` entirely. Adopt the framework's standard contract-space layout:

```
<app>/
├── migrations/
│   ├── refs/
│   │   └── head.json                    ← bundled into contractSpace.headRef
│   └── app/
│       └── <ts>_<slug>/                 ← each package's ops.json + end-contract.json
│           ├── migration.json
│           ├── ops.json
│           ├── end-contract.json
│           └── migration.ts
└── src/
    └── prisma/
        ├── contract.prisma
        ├── contract.json
        └── contract-space.generated.ts  ← JSON-imports the above, exports a ContractSpace
```

No special-case file. The IDB target stops being a storage-layer outlier and becomes a contract space like any other, with a browser-side apply path that uses IDB's native version-counter mechanism as its trigger.

---

## Group B — Independent cleanups

These four don't depend on the Group A decision and can be addressed on their own.

### 4. The browser's migration policy shouldn't allow destructive operations by default

In `auto-migrate.ts`, the policy is hard-coded:

```ts
const ALLOW_ALL = {
  allowedOperationClasses: ["additive", "widening", "destructive", "data"] as const,
};
```

ADR 008 justifies this as "single user, no review step needed." That's confusing two different things: _who reviews the migration_ (no one, agreed — the user isn't going to read a diff before opening a tab) and _what operations should run silently_ (a different question with a different answer).

A user's local IndexedDB can hold months of accumulated state — drafts, offline queue, cached content, saved searches. A contract change that drops a store wipes that data the next time they open the app, with zero warning to them or to the developer. That's a real product-quality risk.

The framework already has a `MigrationOperationPolicy` mechanism. Expose it on the public API and default to safe:

```ts
createAutoMigratingIdbClient({
  contractSpace,
  dbName,
  policy: {
    allowedOperationClasses: ["additive", "widening"],
    onDestructive: "refuse",
  },
});
```

Today's behavior becomes opt-in (`onDestructive: 'allow'`), not the default.

---

### 5. The marker store has a single hard-coded row, which will break when IDB supports extensions

The marker store record is written as `{ id: "default", storageHash, profileHash, updatedAt }` — a single row with a literal `"default"` key. ADR 001 justifies this by noting that IDB doesn't support extensions today.

The framework went through this exact migration on the SQL side. Originally the marker table was a single row keyed `id = 1`. ADR 021 then changed it to one row per contract space (the app plus every loaded extension), keyed by `space`. The migration was non-trivial — see ADR 021 for the three-state idempotent migration story.

You can avoid that future pain now, for free. Key the marker row by the space identifier (defaulting to `"app"` from the framework's `APP_SPACE_ID` constant) from day one. The current behavior is identical — there's only ever one row, and it's the `"app"` row — but the storage layout doesn't have to be migrated later when IDB does eventually grow extensions.

While you're there: the manifest marker carries `invariants[]`, `contractJson`, `canonicalVersion`, `appTag`, `meta` (matching the framework's `ContractMarkerRecord`), but the in-database marker store record only carries three fields. These should line up — the same record shape in both places.

---

### 6. `executeAcrossSpaces` duck-types the driver to detect manifest IO

There's a comment in the source explaining it: `// This avoids importing family-idb from target-idb (circular dependency).` The runner checks whether the driver happens to have `readManifest` and `writeManifest` methods, and if so, treats it as a manifest-backed driver.

This is the kind of workaround that's fine in isolation but tends to grow problems over time:

- It's fragile against any future driver that happens to have similarly-named methods.
- It hides what should be a first-class framework concept — a control plane that talks to a file rather than a database — inside an ad-hoc shape check.
- The circular dependency is a structural problem; resolving it via duck typing means the structural problem doesn't get fixed.

The fix is to add a proper interface in `framework-components/control` (alongside the existing `ControlDriverInstance`) that any file-backed driver can implement. `target-idb`'s runner then depends on the interface, not on a duck-typed shape. `family-idb` implements the interface and registers it through the existing component discovery mechanism.

This is worth raising as a framework-level question, not just an IDB-side fix. If Mongo or any future target ever wants a similar setup, the abstraction is reusable.

---

### 7. The `fake-indexeddb` dry-run should be a standalone `migration preflight` command

`executeAcrossSpaces` currently does the following on every invocation:

1. Spins up a `fake-indexeddb` instance.
2. Seeds it by applying the manifest's current schema to it.
3. Applies the new operations on top.
4. If both succeed, writes the new manifest.

It's a tripwire — and the instinct is good — but it's in the wrong place for a few reasons:

- **It validates against the wrong oracle.** `fake-indexeddb` is a separate implementation of the IDB spec, with its own bugs and divergences from Chrome, Firefox, and Safari. The dry-run can produce both false positives (CLI fails on something a real browser would accept) and false negatives (CLI passes on something a real browser would reject).
- **It substitutes a runtime check for missing test coverage.** Whatever the dry-run might catch should be caught by unit tests on the diff function plus integration tests on the runner. Running the simulator on every CLI invocation is workflow tax for evidence you should already have from the test suite.
- **It ships a test-only package on a production path.** Anyone using the CLI now needs `fake-indexeddb` installed in their dependency tree.

The framework already has a name for this: preflight. ADR 001 (upstream) says _"Preflight is mandatory in CI: apply edges in a shadow database or run EXPLAIN-only checks."_ The dry-run is exactly preflight — it just shouldn't be bolted into the only CLI path the user has.

The fix:

- Pull the `fake-indexeddb` shadow walk out of `executeAcrossSpaces` and into its own explicit command, `prisma-next migration preflight`.
- CI runs `migration preflight` as a gate.
- The CLI's authoring commands (`migration new` / `migration plan`) write packages and trust unit-tested planner correctness; they don't run the shadow walk.

Once Group A is adopted, `migration preflight` gets more powerful: it can apply every `ops.json` in the chain from empty to tip against a shadow `fake-indexeddb` instance — the actual test of "does this chain apply cleanly" — instead of today's narrower "does this one delta apply on top of a schema snapshot."

---

## One operational issue worth flagging separately

This isn't a design issue — it's an implementation footgun, but it's load-bearing for the auto-migration story to work in real apps.

When a user has tab A open at `idbVersion = 5` and opens tab B at a contract that needs `idbVersion = 6`, tab B's `factory.open(name, 6)` fires a `blocked` event and **hangs indefinitely** unless tab A's open connection listens for the `versionchange` event and closes itself. I don't see that handler registered anywhere in `idb-client.ts`. It's invisible in tests (single fake-indexeddb instance, no multi-tab) but will bite production users the first time someone opens the app in two tabs across a deploy.

The fix is a few lines wherever you own the open connection: listen for `versionchange` on the `IDBDatabase`, close the connection, and (optionally) surface a "please reload" signal to the application layer.

---

Happy to go deeper on any of these — particularly Group A, since it's the load-bearing decision.
