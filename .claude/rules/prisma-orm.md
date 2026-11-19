---
description: "Prisma 8 packages: architecture, package boundaries, upstream parity and build order."
paths: "packages/prisma-orm/**, apps/prisma-orm-*/**, tests/prisma-idb-cli/**"
globs: "packages/prisma-orm/**, apps/prisma-orm-*/**, tests/prisma-idb-cli/**"
alwaysApply: false
applyTo: "packages/prisma-orm/**,apps/prisma-orm-*/**,tests/prisma-idb-cli/**"
---

# Prisma 8 packages

## Know the design before changing it

- [ARCHITECTURE.md](../../packages/prisma-orm/docs/ARCHITECTURE.md) explains the two planes, how a query runs, query planning, and how a schema change reaches the browser. Read the section for the area you change.
- Check the [ADR index](../../packages/prisma-orm/docs/adrs/INDEX.md) for decisions in your area. Don't contradict an accepted ADR without asking. A new cross-cutting decision needs a new ADR (`write-adr` skill).
- When a change alters a documented shape (contract, public type, CLI output, sync payload), update ARCHITECTURE.md, the package README and the docs site in the same change.

## Planes and boundaries

- Build-time code (authoring, contract emit, migration planning, the CLI) must stay out of browser bundles. Extension contract spaces are the documented exception.
- The CLI plans IndexedDB migrations. The browser applies them, as written.
- Each package exposes what it owns through `package.json` `exports`. Import across packages through those entry points, never through `src/` paths.

## Upstream parity

Behavior should match upstream Prisma 8 unless an ADR records the difference. Pin upstream links to a commit SHA, not a branch. Use the `port-prisma-behavior` skill for the procedure.

## Build order

Tests and type checks read dependencies from their built `dist`. After changing `target-idb` or `family-idb`, rebuild before testing `client-idb`, `sync-extension-idb` or the CLI tests. `pnpm exec turbo run test --filter=<pkg>` rebuilds dependencies for you; a direct `vitest run` doesn't.

The CLI tests in `tests/prisma-idb-cli` run the built `prisma-idb` binary, so they need `family-idb` and `target-idb` rebuilt.
