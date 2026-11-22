# prisma-idb

Prisma clients for IndexedDB, with optional sync to a server. This is a pnpm workspace managed by Turborepo. It ships two products:

- **Legacy generator** (`packages/generator`, published as `@prisma-idb/idb-client-generator`): a Prisma generator that writes a typed IndexedDB client. Stable; changes are mostly fixes.
- **Prisma 8 integration** (`packages/prisma-orm/*`, published as `@prisma-idb/*`): an IndexedDB target, ORM client, CLI and sync packages built on Prisma 8. Active development happens here.

`AGENTS.md` and `.github/copilot-instructions.md` are symlinks to this file. Edit `CLAUDE.md` only.

## Layout

| Path                                                                   | What it is                                                                                                          |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `packages/generator`                                                   | Legacy generator. Client output is written in `src/fileCreators` with `code-block-writer`.                          |
| `packages/prisma-orm/target-idb`                                       | Codecs, contract types and migration planning.                                                                      |
| `packages/prisma-orm/family-idb`                                       | Schema authoring (PSL and TypeScript) and the `prisma-idb` CLI.                                                     |
| `packages/prisma-orm/{driver,adapter,runtime,client}-idb`              | IndexedDB execution and transactions, plan translation, middleware wiring, and the typed ORM.                       |
| `packages/prisma-orm/{sync-extension-idb,sync-server,sync-server-sql}` | Browser outbox and worker, server authorization rules, and the SQL adapter.                                         |
| `packages/prisma-orm/docs`                                             | [ARCHITECTURE.md](packages/prisma-orm/docs/ARCHITECTURE.md) and the [ADRs](packages/prisma-orm/docs/adrs/INDEX.md). |
| `apps/usage`, `apps/kanban-example`                                    | Demo apps and browser tests for the legacy generator.                                                               |
| `apps/prisma-orm-usage`, `apps/prisma-orm-kanban-example`              | Demo apps and browser tests for Prisma 8.                                                                           |
| `apps/docs/content/docs`                                               | Documentation site (Fumadocs MDX).                                                                                  |
| `tests/schema-gen`, `tests/prisma-idb-cli`                             | Legacy generated-client tests and Prisma 8 CLI tests. Prisma 8 packages keep their own tests in `test/`.            |
| `vendor/prisma`                                                        | Optional, gitignored clone of `prisma/prisma` for reading upstream code. It may be missing or stale.                |

## Rules that always apply

- Use `pnpm`, never `npm` or `npx`. Use the pnpm version pinned in `package.json`. Never edit `pnpm-lock.yaml` by hand.
- Never hand-edit generated output: `**/src/lib/prisma-idb/**` (legacy clients), emitted `contract.json`/`contract.d.ts`, and migration `snapshots/`. Change the generator or the schema and regenerate. A hook blocks these edits.
- Inside an IndexedDB transaction, never `await` anything that is not an IndexedDB request. The transaction commits as soon as the event loop is idle, so a stray `await` silently breaks atomicity. Chain requests through callbacks.
- Browser packages must not import `node:*` modules. `tsc` and Vitest both miss this; only the Playwright suites catch it.
- Vitest does not type-check. Run `pnpm check` before you call a change done.
- Write comments, error messages and docs as plain, direct prose. State the behavior and the reason inline. Don't refer to plans, phases or ADR numbers in code comments or error messages.
- Commit messages use Conventional Commits with a package scope, for example `fix(family-idb): keep the cause on contract emit failures`. Don't add a `Co-Authored-By` trailer.
- Commit, push or open a PR only when asked.

## Commands

Run from the repository root. Prefer the smallest check that covers the change; the `verify-change` skill explains which to pick and what each one needs.

```bash
pnpm install --frozen-lockfile                                   # install
pnpm generate                                                    # regenerate demo and test clients (needed on a fresh checkout)
pnpm exec turbo run test --filter=@prisma-idb/client-idb         # one package, rebuilding its dependencies first
pnpm --filter @prisma-idb/client-idb exec vitest run test/x.test.ts  # one file (dependencies must already be built)
pnpm exec turbo run check lint --filter=@prisma-idb/client-idb   # one package's types and lint
pnpm test:prisma-idb                                             # all Prisma 8 unit and contract tests
pnpm test:prisma-idb-e2e                                         # Prisma 8 browser suite (Playwright)
pnpm test:generator-schema                                       # legacy generator schema tests
pnpm check                                                       # all types, plus descriptor and agent-file consistency
pnpm lint                                                        # ESLint and Prettier
pnpm format                                                      # write formatting
```

A package's tests run against the built `dist` of the packages it depends on. After changing `target-idb` or `family-idb`, rebuild them (`turbo run test` does this for you) or downstream tests run stale code.

## Before you change things

- Read [ARCHITECTURE.md](packages/prisma-orm/docs/ARCHITECTURE.md) and the relevant [ADRs](packages/prisma-orm/docs/adrs/INDEX.md) before you change package boundaries, contracts, migrations, transactions or sync. If a change contradicts an accepted ADR, stop and ask. Domain terms are defined in the [glossary](packages/prisma-orm/docs/ARCHITECTURE.md#glossary).
- Prisma 8 behavior should match upstream Prisma unless an ADR records a difference. Use the `port-prisma-behavior` skill when you port or compare behavior.
- Every behavior change needs a test, or a stated reason why it doesn't. Use the `testing` skill to decide.
- `packages/prisma-orm/plans/` holds working notes for agents, not developer docs. Durable decisions go in ADRs.

## Before you call a change done

Review comments on past PRs mostly found the same few gaps. Check for them yourself first:

1. **Every path, not just the main one.** For each new check, option or behavior, list every place it must apply (all write operations and their nested, bulk and per-row branches; both PSL and TypeScript authoring; every generator, phase and field kind; every wrapper of a changed API) and confirm each one.
2. **Every claim matches the code.** Docs, changesets, comments, error messages and diagnostics. Search for wording your change made stale.
3. **Every test can fail.** Break the code under test and watch the test fail.
4. **Scale and failure.** No per-row store scans, no spreading unbounded arrays, no error that hides the original one.

After a multi-file implementation, and before opening a PR, run the `change-reviewer` subagent (or the `review-change` skill in other tools), fix what it confirms, then run the checks from `verify-change`. In Claude Code, a hook blocks `gh pr create` on a branch with two or more changed source files, or one in a write, migration or sync package, until `node .claude/hooks/require-review.mjs --mark` records the review. Run that only after the review actually ran.

## Changesets and releases

- Add a `.changeset/*.md` (`pnpm changeset`) for each published package a change affects. For docs-only or other non-release changes, add an empty one (`pnpm changeset --empty`).
- `target-idb`, `driver-idb`, `adapter-idb`, `runtime-idb`, `client-idb` and `family-idb` release together at one version ([.changeset/config.json](.changeset/config.json)). Sync packages and the legacy generator version separately.
- Releases are automated by [release.yml](.github/workflows/release.yml). Don't run `changeset version` or `changeset publish`.

## Agent files

Each kind of agent file has one canonical home. Other tools reach it through committed symlinks that `pnpm agents:sync` creates and `pnpm check` verifies.

| What                              | Canonical                        | Symlinks                                                                  |
| --------------------------------- | -------------------------------- | ------------------------------------------------------------------------- |
| Project instructions              | `CLAUDE.md`                      | `AGENTS.md`, `.github/copilot-instructions.md`                            |
| Path-scoped rules                 | `.claude/rules/<name>.md`        | `.cursor/rules/<name>.mdc`, `.github/instructions/<name>.instructions.md` |
| Skills                            | `.claude/skills/<name>/SKILL.md` | `.agents/skills` (read by Codex and Cursor)                               |
| Claude Code subagents             | `.claude/agents/<name>.md`       | none                                                                      |
| Claude Code permissions and hooks | `.claude/settings.json`          | none                                                                      |

Edit the canonical file, never the symlink. Checkouts with `core.symlinks=false` get the links as plain text files; `pnpm agents:check` skips them there. After adding or renaming a rule, run `pnpm agents:sync`. Personal notes go in `CLAUDE.local.md` (gitignored).

Rules load automatically when you touch matching files. Agents without path-scoped rules should read the matching rule before editing:

| Rule                                                  | Applies to                                                   |
| ----------------------------------------------------- | ------------------------------------------------------------ |
| [legacy-generator](.claude/rules/legacy-generator.md) | `packages/generator`, `tests/schema-gen`                     |
| [prisma-orm](.claude/rules/prisma-orm.md)             | `packages/prisma-orm`                                        |
| [idb-runtime](.claude/rules/idb-runtime.md)           | Runtime source of the Prisma 8 packages that touch IndexedDB |
| [authoring](.claude/rules/authoring.md)               | `family-idb` and `target-idb` source                         |
| [tests](.claude/rules/tests.md)                       | Test files                                                   |
| [adrs](.claude/rules/adrs.md)                         | `packages/prisma-orm/docs/adrs`                              |
| [docs](.claude/rules/docs.md)                         | Markdown and the docs site                                   |

Skills, loaded on demand: `testing`, `verify-change`, `review-change`, `open-pr`, `write-adr`, `port-prisma-behavior`. Subagent: `change-reviewer`, which runs `review-change` in a fresh context.
