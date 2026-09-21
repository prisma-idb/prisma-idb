# ADR 011 — No Migration Materialization for IDB Extensions

## Status

Decided — implemented.

## Context

Upstream [ADR 212 — Contract spaces](https://github.com/prisma/prisma-next/blob/main/docs/architecture%20docs/adrs/ADR%20212%20-%20Contract%20spaces.md) describes a **materialization** step for the SQL family: every `prisma-next migrate` invocation copies a pinned mirror of each loaded extension's current contract, head ref, and migration packages _into the consuming application's own repo_, under `migrations/<space-id>/`. The app's repo ends up containing both its own migrations and physical copies of every extension's migration history, side by side.

This exists to serve a specific set of guarantees, spelled out directly in ADR 212:

- **CI / production apply without the extension installed.** `db init`, `db apply`, and `db verify` read _only_ the user's repo — they never import an extension descriptor module. This is what lets those commands run in locked-down environments (a CI runner, a production deploy pipeline) that may not have `node_modules` populated or network access to npm at all.
- **PR-visible diffs.** Bumping an extension's version produces a visible diff in the _consuming app's_ PR (updated pinned `contract.json`/`contract.d.ts`/`refs/head.json`, plus any new migration directories) — reviewable like any other schema change, in the repo where the reviewer is looking.
- **Drift detection independent of `node_modules`.** `db verify` compares the live database against the pinned mirror, so it works even if the installed extension version has since changed or drifted from what's pinned.

IDB extensions (the sync extension being the first real example) use the _same_ contract-space model — `IdbExtensionSpace`, `createAutoMigratingIdbClient({ extensions: [...] })` — but do **not** materialize anything into the consuming app's repo. This is a deliberate divergence, not a gap, because the problem materialization solves does not exist for IDB.

## Decision

An IDB extension's migration data lives and stays in the extension package's own repo. Consuming apps import the extension's compiled control descriptor directly at runtime (`import { idbSyncExtension } from "@prisma-idb/sync-extension-idb/control"`) — nothing from the extension is ever copied into the app's own `migrations/` folder.

`prisma-idb generate-baseline --space <id>` and `prisma-idb generate-migration --space <id>` (see `family-idb/src/core/generate-baseline.ts`, `generate-migration.ts`) are how an extension author authors that history — run _inside the extension package's own repo_, against its own `migrations/`, exactly like an app author runs the same commands (without `--space`) inside their own app repo. There is no separate "sync this into consuming apps" step; the next `pnpm install`/rebuild of the consuming app picks up the new migration data because it's bundled with the package itself.

## Why materialization's guarantees don't apply to IDB

**IDB has no CLI-driven apply or verify path at all.** `IdbMigrationRunner.execute()` and `executeAcrossSpaces()` always return an `IDB-CLI-UNSUPPORTED` refusal envelope (see the INDEX.md "Post-Phase-7 architectural notes"); `db init`/`db apply`/`db verify` don't do anything for IDB targets. The entire reason materialization exists upstream — letting those commands run without the extension installed — doesn't apply, because those commands don't run for IDB in the first place, anywhere.

**Migrations only ever execute in exactly one place: the end user's browser, as part of the JS bundle you shipped them**, via `createAutoMigratingIdbClient`. There is no separate server-side or CI-side apply step for IDB to make independent of `node_modules`.

**The extension's migration data is unconditionally already present wherever migrations run, by construction.** Since the extension is a real npm dependency of the consuming app, `import { idbSyncExtension } from "@prisma-idb/sync-extension-idb/control"` gets bundled into the app's JS at build time. If the extension package weren't installed, the build itself would fail — `vite build`/`tsdown` would error on the unresolved import — long before any migration ever runs. There is no scenario where the app is running but the extension's migration data isn't already right there in memory. Materializing a copy into the app's own `migrations/` folder would duplicate something that's already unconditionally present at the only point it's ever needed.

## What we accept losing

**No PR-visible diff in the consuming app's repo when an extension bumps its schema.** Upstream gets this for free from the copy step; we don't. An app author bumping `@prisma-idb/sync-extension-idb` sees a `package.json`/lockfile diff, not a migration-directory diff — they'd need to check the extension's own changelog or repo to see what schema changed. This is an accepted, minor DX tradeoff, not an oversight: gaining it would mean building a copy step that exists solely to serve a use case (offline/CI apply) that never arises for IDB.

## What we deliberately did not do

**Build a `migrate`-equivalent materialization/copy step for IDB.** Considered and rejected: it would require the framework CLI (or `prisma-idb`) to know how to enumerate and copy an extension's pinned artifacts into an app's `migrations/<space-id>/`, entirely to serve CI/production apply paths IDB doesn't have. Pure overhead — more surface to keep in sync, no corresponding capability gained.

**Require consuming apps to pin a copy of `migrations/refs/head.json` locally.** Since the app never reads migration files directly (it reads the compiled `IdbExtensionSpace` object the extension package exports), there's nothing for a locally-pinned ref to check against that the extension's own bundled `headRef` doesn't already provide.

## Consequences

- `generate-baseline --space <id>` and `generate-migration --space <id>` are run by extension authors, inside their own package repo — never by consuming-app authors on the app's behalf. An app author never needs `--space` at all; it's exclusively extension-package tooling.
- Extension version bumps are ordinary dependency bumps from the consuming app's point of view — no separate "sync migrations" step, no separate CLI command to remember to run after `pnpm update`.
- Auditing what an extension version bump changed means reading that extension's own changelog/repo, not a diff in the consuming app's PR.
- If IDB ever grows a genuine CI/production-side apply or verify path (it doesn't today — see ADR 001's and the INDEX's notes on `IDB-CLI-UNSUPPORTED`), this decision would need revisiting, since that's precisely the scenario materialization exists to serve.

## Related

- Upstream [ADR 212 — Contract spaces](https://github.com/prisma/prisma-next/blob/main/docs/architecture%20docs/adrs/ADR%20212%20-%20Contract%20spaces.md) — defines materialization for the SQL family; the "What apply-time does not need" section is the source of the guarantees this ADR explains don't apply to IDB.
- [ADR 010](./ADR%20010%20-%20Combined%20Single-Transaction%20Multi-Space%20Apply.md) — the runtime side of multi-space support (how a consuming app applies an extension's migrations once imported); this ADR covers the authoring/distribution side (how an extension's migrations get to the consuming app in the first place).
- `family-idb/src/core/generate-baseline.ts`, `generate-migration.ts` — the `spaceId` option extension authors use against their own package repo.
- `sync-extension-idb/` — the first real IDB extension package, and the worked example this ADR is grounded in.
