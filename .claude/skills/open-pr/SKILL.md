---
name: open-pr
description: Prepare and open a pull request for prisma-idb with a changeset, a conventional title and a description that follows the PR template. Use when the user asks to open, create or submit a PR.
disable-model-invocation: true
argument-hint: "[base-branch]"
---

# Open a pull request

## 1. Check the branch

```bash
BASE=${1:-main}
git status -sb
git log --oneline "origin/$BASE..HEAD"
git diff --stat "origin/$BASE...HEAD"
```

- If you are on `main`, create a branch first: `<type>/<short-topic>`, for example `fix/query-cursor` or `docs/agent-setup`.
- Call out uncommitted changes. They won't be in the PR unless committed, and unrelated ones must stay out.
- Read the full diff before writing anything about it.

## 2. Add a changeset

- For each published package the diff changes, add a changeset with `pnpm changeset` and pick the semver bump. Write the summary for users of the package: what changed and what they need to do.
- The six core Prisma 8 packages (`target`, `driver`, `adapter`, `runtime`, `client`, `family`) share one version, so one changeset naming the packages you touched is enough.
- For docs-only, CI-only, app-only or test-only changes, add an empty changeset: `pnpm changeset --empty`.

## 3. Verify

Use the `verify-change` skill. At minimum, the relevant tests and `pnpm check` pass.

## 4. Commit

Conventional Commits with a scope: `type(scope): lowercase summary`. Types: `feat`, `fix`, `docs`, `test`, `refactor`, `chore`, `ci`, `build`, `perf`. The scope is the package or app directory name, for example `client-idb` or `prisma-orm-kanban-example`. Stage files by name, not with `git add -A`. No `Co-Authored-By` trailer.

## 5. Write the PR

Title: the same format as a commit, under 70 characters, naming the concrete change.

Body, following [.github/PULL_REQUEST_TEMPLATE.md](../../../.github/PULL_REQUEST_TEMPLATE.md):

- **Description**: what changed and why, in a few sentences. Lead with the user-visible effect. Link an issue only if one exists (`Fixes #N`).
- **Type of change**: keep only the options that apply.
- **How has this been tested?**: the tests you added or extended (`file > test name`), the checks you ran with results, and any you skipped with the reason. If no test was added, say why.
- Name the ADR or upstream code you followed, and flag any deliberate difference from upstream Prisma for review.

Show the title and body to the user before running:

```bash
git push -u origin HEAD
gh pr create --base "$BASE" --title "<title>" --body-file <file>
```
