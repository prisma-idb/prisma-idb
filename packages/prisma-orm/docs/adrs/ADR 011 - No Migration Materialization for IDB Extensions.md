# ADR 011: Don't copy extension migrations into apps

- **Status:** Accepted
- **Date:** 2026-08-02
- **Area:** Migrations, CLI

## Summary

An IndexedDB extension, such as the sync extension, keeps its migrations inside its own npm package. Apps import the extension, and its migrations come along in the app's JavaScript bundle. Unlike the SQL family, nothing is copied into the app's own `migrations/` folder. That copy exists upstream so the CLI can apply and verify migrations without the extension installed, and IndexedDB never applies or verifies migrations from the CLI.

## Context

Upstream ADR 212 (Contract Spaces) describes a copy step for the SQL family, called materialization. Each run of `migrate` copies every loaded extension's contract, head ref and migration packages into the app's repo, under `migrations/<space-id>/`.

The copy provides three guarantees:

- **Apply and verify without the extension installed.** The `db` commands read only the app's repo and never import the extension. So they work in locked-down CI or deploy environments without `node_modules` or network access.
- **Visible diffs.** Upgrading an extension shows its schema changes as a diff in the app's own pull request.
- **Drift checks that don't depend on `node_modules`.** `db verify` compares the live database with the copy, even if the installed extension has since changed.

IndexedDB extensions use the same contract-space model (`IdbExtensionSpace`, passed as `createAutoMigratingIdbClient({ extensions: [...] })`), but don't copy anything into the app.

## Decision

An extension's migrations live in, and stay in, the extension's own package. The app imports the extension's bundled contract space directly:

```ts
import { idbSyncExtension } from "@prisma-idb/sync-extension-idb/control";

const db = await createAutoMigratingIdbClient({ contractSpace, dbName: "my-app", extensions: [idbSyncExtension] });
```

The extension's author plans its migrations inside the extension's own repo with `prisma-idb migration plan --space <id>`, just as an app author runs `prisma-idb migration plan` in the app's repo ([ADR 018](ADR%20018%20-%20Separate%20prisma-idb%20CLI.md)). There is no separate step to sync them into apps. When an app installs a new version of the extension, its next build includes the new migrations.

## Why the copy's guarantees don't apply

- **IndexedDB has no CLI apply or verify.** The migration runner's `execute()` always returns a refusal, and the `db` commands can't reach a browser database. The main reason for the copy, letting those commands run without the extension, doesn't arise.
- **Migrations only run in one place:** the user's browser, from the bundle the app ships, through `createAutoMigratingIdbClient`.
- **The extension's migrations are always present where they run.** The extension is a real dependency of the app, so the bundler includes its contract space at build time. If the extension weren't installed, the build would fail on the unresolved import long before any migration could run. A copy in `migrations/` would duplicate data that is always already there.

## Alternatives considered

- **Build a copy step for IndexedDB.** The CLI would have to find each extension's migrations and copy them into `migrations/<space-id>/`, only to serve CLI apply and verify paths that IndexedDB doesn't have. Rejected: more to maintain, nothing gained.
- **Make apps keep a local copy of the extension's head ref (`migrations/refs/head.json`).** The app never reads migration files. It reads the contract space the extension exports, which already includes its head ref. A local copy would have nothing to check against. Rejected.

## Consequences

- Only extension authors use `--space`, and only inside their own package. App authors never need it.
- Upgrading an extension is an ordinary dependency upgrade, with no extra command to run afterwards.
- **What we give up:** an app's pull request shows only a `package.json` and lockfile change when an extension's schema changes, not a migration diff. To see what changed, read the extension's changelog. We accept this: getting the diff would mean building a copy step for a use case IndexedDB doesn't have.
- If IndexedDB ever gains a real CLI or CI apply or verify path, this decision should be revisited, because that is exactly what the copy is for.

## Related

- [ADR 010](ADR%20010%20-%20Combined%20Single-Transaction%20Multi-Space%20Apply.md): how the app applies the extension's migrations once it has them.
- `family-idb/src/core/extension-space.ts`: `IdbExtensionSpace`.
- `sync-extension-idb/`: the first IndexedDB extension, and the example this ADR is based on.
