---
name: review-change
description: Review a finished change in prisma-idb for the mistakes that most often reach pull requests, before the PR is opened. Use after a multi-file implementation, before the open-pr skill, when asked to review a branch or diff, or when addressing review comments.
argument-hint: "[base-branch]"
---

# Review a change before the PR

These checks come from the review comments on past pull requests. Most findings were not hard bugs. They were gaps that the author could have found by asking "where else does this apply?" and "would this test fail if the code were wrong?".

In Claude Code, run this review in the `change-reviewer` subagent, so a fresh context reads the diff without the author's assumptions. Other agents can follow the steps directly.

## 1. Read the whole change

```bash
BASE=${1:-main}
git diff --stat "origin/$BASE...HEAD"
git diff "origin/$BASE...HEAD"
git diff HEAD        # staged and unstaged changes to tracked files
git status --short   # uncommitted work is part of the review too
```

Read each changed function in full, not only the diff hunks. Read each untracked file that `git status --short` lists in full. For every new rule, option, check or behavior in the diff, write down one sentence: "This change makes X true for Y."

## 2. Find every place it should apply

This is the most common finding. A change lands on the main path and misses a sibling path.

For each sentence from step 1, list the other paths where Y occurs, and confirm each one has the change. Search for them; don't rely on memory.

| If the change touches            | Also check                                                                                                                                                                                                                                                                                                |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A write in `client-idb`          | `create`, `createAll`/`createCount`, `update`, `updateAll`/`updateCount`, `upsert`, `delete`, `deleteAll`/`deleteCount`, nested `create`/`connect`/`disconnect`, bulk `write()`, and the scan and per-row branches of each. Apply the [write-path list](../../rules/idb-runtime.md) ("Every write path"). |
| Schema authoring in `family-idb` | Both front ends: PSL (`psl-binder.ts`, `psl-interpreter.ts`) and TypeScript (`contract-builder.ts`, `validate-definition.ts`). Also relation fields, excluded fields and key fields. See the [authoring rule](../../rules/authoring.md).                                                                  |
| A value kind or phase            | Every kind, not only the one you added: each generator, `onCreate` and `onUpdate`, scalar and list, nullable and required, single and composite keys.                                                                                                                                                     |
| An option on a lower-level API   | Every wrapper that constructs that API forwards it or documents that it can't, for example `createSqlSync` around `createSqlSyncAdapter`.                                                                                                                                                                 |
| A type                           | The runtime validator accepts exactly the values the type accepts. A type that allows `{}` while the validator rejects it is a bug.                                                                                                                                                                       |
| A rule, skill or doc             | Other agent files and docs that state the same thing. Two instructions must not disagree.                                                                                                                                                                                                                 |

## 3. Check validation order and inputs

- Validate the input as the user wrote it, before merging, lowering, normalizing or taking an early branch. A later step can replace or skip the value you meant to check.
- Read user-supplied objects once. Capture the values, then validate and use the captured copy.
- Untyped JavaScript callers exist. `typeof null === "object"`; names such as `__proto__` reach `Object.fromEntries` and plain-object maps. Use `Map` or `Object.create(null)` for name-keyed data, and reject what you can't handle with the package's own error type.
- Parse external formats the same way their consumer does, for example URL-decode a database name taken from a connection string.

## 4. Check every written claim

Docs, READMEs, changesets, code comments, error messages, diagnostics and test names are claims. Reviewers check them against the code, so check them first.

- Each claim matches the code in this diff: status codes, flag names, accessor paths (`db.orm.<model>`), what a command does and does not do.
- A diagnostic that suggests a replacement suggests one that is valid. Paste it into a test.
- A changed behavior leaves no stale statement elsewhere. Search the repository for the old wording, including `apps/docs/content/docs`.
- The changeset describes what users get, and is empty when no published package changes (a test-only change is not a release).

## 5. Check that each test can fail

For each new or changed test, ask what it would do if the feature were broken. Look for:

- Loops over a possibly empty collection, and `toMatchObject` or partial matching on the field that proves the behavior.
- Results that a fallback could also produce: a system default, an unrelated error, an empty `stdout` from a process that never started.
- Assertions on a status without the specific error code, or on "rejected" without why.
- Spies, mocks and global patches restored only on the success path. Restore them in `finally` or `afterEach`.
- Helpers that return a different shape than the code under test reads.
- Inputs that never exercise the risky case: a write test whose generated field is not a foreign key or a referenced field, an `include()` test with three parents instead of many.

The surest check: revert or break the fix locally and confirm the test fails.

## 6. Check behavior at scale and under failure

- No full-store scan per row or per entry. Use the index or read once. Quadratic work passes small tests and hangs real users.
- No spreading an unbounded array into arguments (`push(...rows)`, `Math.max(...values)`). It throws `RangeError` on large inputs.
- An error from a listener, subscriber or user callback does not replace the original failure.
- Errors keep their cause, including the inner errors of an `AggregateError`.
- Requests that send credentials or auth headers set an explicit `redirect` policy.
- Scripts run on a fresh checkout, without `DATABASE_URL` for static checks, from any working directory, and with CRLF files. They never delete a real file or folder they didn't create.

## 7. Report

For each finding, give the file and line, the concrete input or state, and the wrong result. Drop anything you can't tie to a failure scenario. Separate findings into:

- **Fix before PR**: bugs and wrong claims.
- **Ask the author**: possible bugs that depend on intent or an ADR.

Skip style and formatting; Prettier and ESLint cover them.

## When addressing review comments

A review comment usually names one instance of a class. Fix the instance, then apply step 2 to find the rest of the class in the same change, and fix those too. Reply with what you changed, or why the finding doesn't apply.
