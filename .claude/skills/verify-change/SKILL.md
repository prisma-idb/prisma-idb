---
name: verify-change
description: Pick and run the checks that prove a change works in prisma-idb, and read their results efficiently. Use before calling any code change done, when a test or type check fails, or when asked to run tests, Playwright suites or `pnpm check`.
---

# Verify a change

Run the smallest set of checks that can fail for your change, then `pnpm check`. CI runs everything else.

## 1. Pick the checks

| You changed                                                    | Run                                                                                                                |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| One Prisma 8 package                                           | `pnpm exec turbo run test --filter=@prisma-idb/<pkg>`                                                              |
| `target-idb` or `family-idb`                                   | The above for that package **and** its dependents: `pnpm exec turbo run test --filter=...@prisma-idb/<pkg>`        |
| CLI behavior                                                   | `pnpm exec turbo run test --filter=@prisma-idb/cli-tests`                                                          |
| Transaction lifetime, bundling, browser-only APIs, client init | Also `pnpm test:prisma-idb-e2e`                                                                                    |
| Sync push, pull or reconcile                                   | `sync-extension-idb`, `sync-server` and `sync-server-sql` tests; for full stack, `pnpm test:prisma-idb-kanban-e2e` |
| Legacy generator source                                        | `pnpm generate`, then `pnpm test:generator-schema`; browser behavior: `pnpm test:generator-client`                 |
| Legacy sync                                                    | `pnpm test:generator-sync`                                                                                         |
| Descriptors or contract emit                                   | `pnpm check:prisma-idb-descriptors`                                                                                |
| Docs, Markdown, agent files                                    | `pnpm exec prettier --check <files>`, and `pnpm agents:check` for agent files                                      |
| Anything with TypeScript                                       | `pnpm check` (always, before you finish)                                                                           |

To iterate on one file once dependencies are built:

```bash
pnpm --filter @prisma-idb/<pkg> exec vitest run test/<file>.test.ts
pnpm --filter @prisma-idb/<pkg> exec vitest run test/<file>.test.ts -t "<test name>"
```

A direct `vitest run` doesn't rebuild dependencies. If a dependency changed, its stale `dist` makes your test lie; use `turbo run test` or build the dependency first.

## 2. Prerequisites

- Fresh checkout: `pnpm install --frozen-lockfile`, then `pnpm generate`.
- Playwright suites need browsers once: `pnpm --dir apps/prisma-orm-usage exec playwright install chromium`.
- `pnpm check` emits the Kanban PostgreSQL contract and needs `DATABASE_URL`. Copy `apps/prisma-orm-kanban-example/.env.example` to `apps/prisma-orm-kanban-example/.env`; no running database is needed for static checks.
- SQL sync tests and the Kanban suites need a running PostgreSQL. Follow the app's README and the matching job in `.github/workflows/build.yml`.
- The legacy Kanban app also needs `PUBLIC_POSTHOG_HOST` and `PUBLIC_POSTHOG_PROJECT_TOKEN` (placeholder values work).

If a prerequisite is missing, say which check you couldn't run and why. Don't report it as passing.

## 3. Run slow checks into a log

Suites that take more than a minute (`pnpm check`, Playwright, `pnpm test:prisma-idb`) produce long output. Run them once, in the background, into a log file, and read the file:

```bash
mkdir -p .cache/agent-logs
pnpm check > .cache/agent-logs/check.log 2>&1; echo "exit $?" >> .cache/agent-logs/check.log
grep -nE "error TS|ERR_|Failed|FAIL" .cache/agent-logs/check.log
tail -40 .cache/agent-logs/check.log
```

Grep the log you have instead of re-running the suite to see different lines. Tell the user roughly how long a slow suite takes before starting it.

## 4. Read failures correctly

- **Vitest green, `pnpm check` red**: Vitest strips types without checking them. The type error is real.
- **Every Playwright spec fails at fixture setup**: the client failed to initialize, often a `node:*` import in browser code. Open the trace or the page's error alert, not the individual specs.
- **A downstream package sees old behavior**: a dependency's `dist` is stale. Rebuild it.
- **Flaky failure**: find the cause. Don't add retries or sleeps.

## 5. Report

List each check you ran with its result, and each relevant check you skipped with the reason.
