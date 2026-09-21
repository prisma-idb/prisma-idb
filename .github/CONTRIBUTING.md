# Contributing

Thank you for considering a contribution! This repo is a pnpm monorepo managed with Turborepo. It contains the legacy generator and the Prisma 8 integration:

| Path                    | Scope                              | Description                                 |
| ----------------------- | ---------------------------------- | ------------------------------------------- |
| `packages/generator`    | `@prisma-idb/idb-client-generator` | Legacy Prisma generator (stable, published) |
| `packages/prisma-orm/*` | `@prisma-idb/*`                    | Prisma 8 IDB packages                       |

## Setup

Requires Node.js ≥ 20 and pnpm.

```bash
git clone https://github.com/prisma-idb/prisma-idb
cd prisma-idb
pnpm install
```

## Development

### Working on `packages/prisma-orm/*`

Build all Prisma 8 packages:

```bash
pnpm build --filter="./packages/prisma-orm/*"
```

Run unit tests:

```bash
pnpm test:prisma-idb
```

Run the browser E2E suite (requires Playwright browsers installed once):

```bash
pnpm --dir apps/prisma-orm-usage exec playwright install --with-deps
pnpm test:prisma-idb-e2e
```

Type-check (catches things vitest/esbuild won't):

```bash
pnpm check
```

> The known local trap: `pnpm test` passes on type errors because vitest uses esbuild. Always run `pnpm check` before pushing. If Playwright specs all fail at fixture setup, suspect a client-init crash — check the page's error alert, not the spec output.

### Working on `packages/generator`

```bash
pnpm build --filter=@prisma-idb/idb-client-generator

# Regenerate the demo client and start the dev server
cd apps/usage
pnpm exec prisma generate
pnpm dev
```

### Formatting and linting

```bash
pnpm format   # write
pnpm lint     # check
```

## Submitting a PR

1. Branch from `main`, use a descriptive name (`fix/...`, `feat/...`).
2. If your change touches a `@prisma-idb/*` package, add a changeset describing what changed:
   ```bash
   pnpm changeset
   ```
   If your PR is docs-only or otherwise doesn't warrant a release, add an empty one to keep CI green:
   ```bash
   pnpm changeset --empty
   ```
3. Open a PR against `main` and describe what changed and why.

---

Please adhere to our [Code of Conduct](CODE_OF_CONDUCT.md).
