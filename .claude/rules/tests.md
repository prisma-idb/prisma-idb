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

Vitest doesn't type-check test files either. Run `pnpm check` too.
