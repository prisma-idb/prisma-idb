# Repository guide

Read [CONTRIBUTING.md](.github/CONTRIBUTING.md) and the affected package's README before changing code. Use existing implementations and tests as examples. This is a pnpm workspace managed by Turborepo. Use the pnpm version pinned in `package.json`; CI installs with `pnpm install --frozen-lockfile` on Node.js LTS.

## Layout and architecture

- `packages/generator`: the stable `@prisma-idb/idb-client-generator`. Change client output in `src/fileCreators`, using `code-block-writer`. Follow [.github/copilot-instructions.md](.github/copilot-instructions.md) for this generator. Run `pnpm generate` after changing its source; fix the generator rather than generated clients.
- `packages/prisma-orm/*`: the Prisma 8 integration. `client-idb` provides the typed ORM; `runtime-idb` connects middleware, adapter and driver; `adapter-idb` translates plans; `driver-idb` owns IndexedDB execution and transactions. `target-idb` provides codecs, contract types and migrations. `family-idb` owns schema authoring and CLI integration.
- `sync-extension-idb`, `sync-server` and `sync-server-sql` under `packages/prisma-orm` provide the browser outbox/worker, authorization rules and SQL adapter, respectively.
- `apps/usage` and `apps/kanban-example` exercise the legacy generator. `apps/prisma-orm-usage` and `apps/prisma-orm-kanban-example` exercise Prisma 8. `apps/docs/content/docs` holds the documentation site. Benchmark apps share `packages/benchmark-kit`.
- `tests/schema-gen` tests legacy generated clients. `tests/prisma-idb-cli` tests the Prisma 8 CLI. Prisma 8 packages keep unit and behavior tests in their own `test` directories.

Read [ARCHITECTURE.md](packages/prisma-orm/docs/ARCHITECTURE.md) and the relevant [architecture decision records](packages/prisma-orm/docs/adrs/INDEX.md) before changing package boundaries, contracts, migrations or transactions. Build-time entry points belong outside browser bundles; extension contract spaces are the documented exception. The CLI plans IndexedDB migrations, and the browser applies them.

Keep driver transaction handlers synchronous. Chain requests through IndexedDB callbacks; an unrelated `await` can let a transaction commit early. See [ADR 005](packages/prisma-orm/docs/adrs/ADR%20005%20-%20Event-Driven%20Execution%20No%20Async%20Await.md).

When porting Prisma behavior, consult upstream code, docs and ADRs in `prisma/prisma` and `prisma/prisma-engines`. For Prisma 8, also follow the pinned `prisma/orm` references in local ADRs. Compare against the dependency versions in the affected package, and record intentional differences.

## Verification

Read [docs/testing-guidelines.md](docs/testing-guidelines.md) before writing or reviewing tests. Every behavior change needs test coverage. Extend an existing test when it already exercises the regression. Check observable results, errors, stored data or generated types. Explain why no new test is needed for docs, formatting or changes covered by existing checks.

Run the smallest relevant checks from the repository root:

| Scope                                                        | Command                                                                                                     |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| One Prisma 8 package and its build dependencies              | `pnpm exec turbo run test --filter=@prisma-idb/adapter-idb` (replace the package name)                      |
| One test file, after dependencies are built                  | `pnpm --filter @prisma-idb/adapter-idb exec vitest run test/adapter.test.ts` (replace the package and path) |
| One package's types and lint                                 | `pnpm exec turbo run check lint --filter=@prisma-idb/adapter-idb`                                           |
| All Prisma 8 unit/contract tests, including CLI and SQL sync | `pnpm test:prisma-idb`                                                                                      |
| Prisma 8 browser client / sync                               | `pnpm test:prisma-idb-e2e` / `pnpm test:prisma-idb-kanban-e2e`                                              |
| Legacy schema / browser client / sync                        | `pnpm test:generator-schema` / `pnpm test:generator-client` / `pnpm test:generator-sync`                    |
| Descriptor consistency                                       | `pnpm check:prisma-idb-descriptors`                                                                         |
| Workspace types / lint                                       | `pnpm check` / `pnpm lint`                                                                                  |
| Selected Markdown files                                      | `pnpm exec prettier --check AGENTS.md` (replace the path)                                                   |

Vitest does not type-check. Run `pnpm check` before pushing, as required by the contribution and testing guides. The Kanban and SQL sync checks need `DATABASE_URL` to emit PostgreSQL contracts, but static checks need no running database. See the Kanban [validation instructions](apps/prisma-orm-kanban-example/README.md#validate-changes).

On a fresh workspace, run `pnpm generate` before full workspace checks to prepare the demo and test clients, as CI's [setup action](.github/actions/action.yml) does. Configure app environment variables as shown in CI, including `PUBLIC_POSTHOG_HOST` and `PUBLIC_POSTHOG_PROJECT_TOKEN` for the legacy Kanban app.

Browser tests need Playwright browsers. SQL sync tests and full-stack sync suites need database setup. Follow the affected app/package README and [.github/workflows/build.yml](.github/workflows/build.yml) for those prerequisites. Use browser coverage when `fake-indexeddb` cannot reproduce the behavior, especially transaction lifetime.

`pnpm format` writes formatting; `pnpm lint` checks it where package scripts include Prettier. Root Markdown is checked with Prettier directly. The pre-commit hook runs `lint-staged`.

## Changesets and releases

- Add a separate `.changeset/*.md` for each affected published package. Name the package and choose the appropriate semantic version bump. Use `pnpm changeset` to create release notes.
- For docs-only or other non-release changes, follow `CONTRIBUTING.md` and add an empty changeset with `pnpm changeset --empty`. The [CI check](.github/workflows/changeset-check.yml) currently runs only when `packages/generator`, `packages/prisma-orm` or `.changeset` changes; it skips `changeset-release/*` branches.
- [.changeset/config.json](.changeset/config.json) fixes `target-idb`, `driver-idb`, `adapter-idb`, `runtime-idb`, `client-idb` and `family-idb` to one release version. Sync packages and the legacy generator are outside that fixed group. Internal dependency updates use patch bumps.
- The [release workflow](.github/workflows/release.yml) runs on relevant pushes to `main`. It checks descriptors, builds the generator and Prisma 8 packages, and uses Changesets to create/update a `chore: release packages` PR or publish ready releases. Leave version and changelog updates to that flow. Do not run publishing commands as part of a normal contribution.

## Branches and pull requests

Branch from `main` with a descriptive conventional name, such as `docs/repository-guide`, `fix/query-cursor` or `feat/idb-feature`. Open the PR against `main` in `prisma-idb/prisma-idb`.

Follow the [PR template](.github/PULL_REQUEST_TEMPLATE.md): describe the change, motivation and change type, then give the relevant checks and results. Link a public issue only when one exists. Cite the existing implementation or design record you followed, explain deliberate deviations, and flag any uncertain repository rule for review.
