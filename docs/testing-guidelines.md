# How to decide what to test

This guide helps you decide whether a change needs a new test, and which kind. Use it when you write a change and when you review one. The goal is confidence per unit of maintenance cost, not coverage.

These are defaults, not laws. If you break one, say why in the pull request.

## Core questions

Answer these before you write a test. Put the answers in the pull request description, or in a short comment above the test if they aren't obvious.

1. **What realistic regression would this test catch?** Name a plausible future change that makes it fail. If you can't, don't write it.
2. **Is it already covered elsewhere?** Search the package, the packages above and below it, and the end-to-end specs. Extend an existing test before you add a new one.
3. **Is this a public contract or an implementation detail?** Test what callers can observe: query results, errors, stored data, generated types. Don't test private structure.
4. **Could a type check or an existing test give the same confidence?** A type error, a lint rule or a generated snapshot is cheaper than a runtime test.
5. **Is the maintenance cost justified by the risk?** A test that breaks on every refactor costs more than the bug it guards against, unless the bug is severe or silent.

## Zero new tests is a valid outcome

Many changes need no new test. Examples:

- A rename, move or refactor that existing tests already exercise.
- A fix whose failure mode an existing test already asserts.
- A change fully checked by the compiler.
- Docs, comments and formatting.

State that no test was added and why. A reviewer can then challenge the reasoning instead of guessing at it.

## Every new test states its unique coverage

For each new test, you can finish this sentence: "If this test did not exist, this regression would ship: …". If an existing test would also fail for that regression, the new test is redundant.

Put that sentence in the test name or the pull request. A good name describes behavior: `rejects a push whose contract fingerprint differs`, not `test push 3`.

## What to prioritize

Spend test effort where a bug is costly, silent or hard to notice. In this repo, that means:

| Area                                                     | Why it ranks high                                                                           |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Query correctness                                        | A wrong filter, sort, cursor or aggregate returns plausible but wrong data.                 |
| Transactions                                             | IndexedDB transactions auto-commit. A stray `await` loses atomicity without an error.       |
| Migrations                                               | A bad upgrade can corrupt or strand user data, and it can't be re-run.                      |
| Generated client contracts                               | The types and runtime shape must match Prisma Client. Consumers depend on them.             |
| Cross-package compatibility                              | Packages version and ship separately. Contract and wire-format drift fails only at runtime. |
| Sync (push, pull, reconcile)                             | Failures lose or duplicate user writes, often only under retries or conflicts.              |
| Edge values (null, Bytes, Date, Decimal, composite keys) | Encoding differences cause silent mismatches in keys and comparisons.                       |

Low-risk glue code, thin wrappers and pass-through re-exports rarely need their own tests.

## Choose the level that gives confidence

Test at the lowest level that can fail for the regression you named. Push a test down when a lower level proves the same thing. Pull it up when only a higher level exposes the failure.

| Level                     | Use it for                                                                          | Example location                      |
| ------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------- |
| Type-level                | Generated and public types, such as inference of `select` and `include`.            | `orm-transaction-types.test.ts`       |
| Unit                      | Pure logic: key comparison, filter building, planner decisions, codecs.             | `target-idb/test`, `adapter-idb/test` |
| Package behavior          | A real ORM against `fake-indexeddb`: queries, writes, transactions, migrations.     | `client-idb/test`                     |
| Snapshot                  | Generated output that humans rarely read, such as emitted contracts.                | `family-idb/test/__snapshots__`       |
| Cross-package or contract | A real server and client exchanging real payloads.                                  | `sync-server-sql/test`, CLI tests     |
| Browser end-to-end        | Behavior only a real browser shows: real IndexedDB, transaction lifetime, bundling. | `apps/prisma-orm-usage/tests`         |

Keep the end-to-end layer small. It is slow and flaky relative to the layers below it. Add a browser spec only when `fake-indexeddb` can't reproduce the failure.

## Write tests that survive refactoring

- **Assert outcomes, not calls.** Check returned rows, thrown errors and stored data. Don't assert that a private function ran, or how many times.
- **Prefer real collaborators.** Use `fake-indexeddb`, a real contract and a real SQL adapter where they exist. Use a fake only at a true boundary, such as the network or the clock.
- **Avoid mocks.** A mock encodes your assumption about the dependency and passes when the assumption is wrong. If you must mock, keep the mock to the boundary and test the real thing elsewhere.
- **Avoid snapshots of internals.** Snapshot only stable, reviewed output. Never accept a snapshot update without reading the diff.
- **Keep each test independent and readable.** Each test sets up its own state and shows its inputs and expected output inline. Don't depend on test order or shared mutable fixtures.
- **Control time, randomness and concurrency.** A test that passes "usually" is a bug. Fix the cause. Don't add retries or sleeps.
- **Test failure paths when failure matters.** Aborted transactions, rejected pushes, contract mismatches and invalid input are part of the contract.
- **Reproduce a bug before you fix it.** Write the failing test first, confirm it fails for the right reason, then fix. Keep it only if it passes the core questions.

## What to avoid

- Testing a function because it exists. Test it because a regression there would matter.
- Asserting on private fields, internal call order or intermediate objects that no caller sees.
- Copying a case at a second level that the first level already proves.
- Large setups that hide what the test is about.
- Assertions that restate the implementation, so the test passes by construction.
- Chasing a coverage number or a fixed number of assertions per test.

## Checks to run

Run the smallest check that covers your change:

```bash
pnpm --filter @prisma-idb/adapter-idb test   # one package
pnpm test:prisma-idb                       # all Prisma 8 packages
pnpm check                                 # types: vitest does not type-check
```

Run `pnpm check` before you push. See [CONTRIBUTING](../.github/CONTRIBUTING.md) for the browser suite.

## For reviewers

Treat a test as code you must maintain. Ask the core questions of every new test. Flag it as redundant, and ask the author to remove or merge it, when:

- An existing test fails for the same regression.
- It asserts implementation details, such as call counts, private state or internal ordering.
- It mocks something a real collaborator could supply.
- It sits at a slower level than needed, such as a browser spec for a pure function.
- It has no stated regression, or its name doesn't describe a behavior.
- It snapshots large or unstable output that nobody will review.

Also flag the opposite: a risky change in a priority area with no test and no stated reason. "No new test, because X" is an acceptable answer. Silence is not.

## Sources

This guide condenses these references to fit this repo:

- [JavaScript Testing Best Practices](https://github.com/goldbergyoni/javascript-testing-best-practices), Yoni Goldberg.
- [Software Engineering at Google](https://abseil.io/resources/swe-book/html/ch12.html), chapter 12, Unit Testing.
- [The Practical Test Pyramid](https://martinfowler.com/articles/practical-test-pyramid.html), Ham Vocke.
- [Test Desiderata](https://testdesiderata.com), Kent Beck.
- [Write tests. Not too many. Mostly integration.](https://kentcdodds.com/blog/write-tests), Kent C. Dodds.
