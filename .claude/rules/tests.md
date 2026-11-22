---
description: "Writing and reviewing tests: when a test is worth adding, which level, and how to keep it robust."
paths: "**/*.test.ts, **/*.test-d.ts, **/*.spec.ts, **/test/**, **/tests/**"
globs: "**/*.test.ts, **/*.test-d.ts, **/*.spec.ts, **/test/**, **/tests/**"
alwaysApply: false
applyTo: "**/*.test.ts,**/*.test-d.ts,**/*.spec.ts,**/test/**,**/tests/**"
---

# Tests

Before adding or reviewing a test, use the `testing` skill ([SKILL.md](../skills/testing/SKILL.md)). The short version:

- Name the realistic regression the test catches. If you can't, don't write it.
- Extend an existing test before adding a new one. Zero new tests is a valid outcome when you say why.
- Assert what callers observe: returned rows, thrown errors, stored data, generated types. Don't assert private calls or internal state.
- Use real collaborators: `fake-indexeddb`, real contracts, the real SQL adapter. Mock only true boundaries such as the network or the clock.
- Test at the lowest level that can fail. Add a Playwright spec only when `fake-indexeddb` can't reproduce the problem.
- Write the failing test before the fix, and confirm it fails for the right reason.
- Never accept a snapshot update without reading the diff. Don't hand-edit emitted contract fixtures; regenerate them.

## Make sure the test can fail

About a sixth of past review findings were tests that passed whatever the code did. Before you finish, break the code under test and confirm the test fails. Watch for:

- A loop over a collection that can be empty, and partial matchers (`toMatchObject`) that skip the field proving the behavior.
- A result a fallback also produces: a system color scheme, an unrelated rejection, empty `stdout` from a process that never launched (`execa` with `reject: false`).
- An assertion that something was rejected without the error code that says why.
- Spies and global patches restored only when the test passes. Restore them in `finally` or `afterEach` (`vi.restoreAllMocks()`).
- Test helpers that return a different shape from what the code under test returns.
- Inputs too small or too plain to reach the risk: many rows for scale bugs, generated values that are foreign keys for write paths.

Vitest doesn't type-check test files either. Run `pnpm check` too.
