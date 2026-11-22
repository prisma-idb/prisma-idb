---
description: "IndexedDB runtime code: transaction lifetime, no stray await, what every write path must check, browser-safe APIs."
paths: "packages/prisma-orm/{driver-idb,runtime-idb,client-idb,adapter-idb,sync-extension-idb}/src/**"
globs: "packages/prisma-orm/driver-idb/src/**, packages/prisma-orm/runtime-idb/src/**, packages/prisma-orm/client-idb/src/**, packages/prisma-orm/adapter-idb/src/**, packages/prisma-orm/sync-extension-idb/src/**"
alwaysApply: false
applyTo: "packages/prisma-orm/driver-idb/src/**,packages/prisma-orm/runtime-idb/src/**,packages/prisma-orm/client-idb/src/**,packages/prisma-orm/adapter-idb/src/**,packages/prisma-orm/sync-extension-idb/src/**"
---

# IndexedDB runtime code

## Transactions commit when you stop using them

An IndexedDB transaction commits as soon as no request is pending and control returns to the event loop. Nothing reports this; later requests fail with `TransactionInactiveError`, or the writes land in separate transactions.

- Keep transaction handlers synchronous. Chain the next request from the previous request's `onsuccess`.
- Never `await` a promise that isn't an IndexedDB request inside a transaction: no `fetch`, no `crypto.subtle`, no timers, no awaiting user callbacks.
- Do async work (hashing, validation that needs promises, network) before opening the transaction or after it completes.
- Read every result row inside the transaction, then yield them after it completes. Don't hold a cursor across an `await`.
- Nested ORM writes compute the stores they need up front. Code that runs inside a transaction must use only the stores it declared.

See ADR 005 (event-driven execution), ADR 006 (collect then yield) and ADR 007 (two transaction APIs) for the reasoning.

## Every write path

A path that writes rows, nested and bulk writes included, must do all of these for the value it actually writes:

- Validate the record and its enum values (`assertValidRecord`, `assertEnumValues`).
- Check foreign keys on every write (`validateScalarFks`), once per row when values differ per row (ADR 009).
- Run `onUpdate` and `onDelete` referential actions (`applyReferentialActionsForRow`, `applyReferentialActionsForRowOnUpdate`), and declare the stores they touch before the transaction opens (ADR 009, ADR 005).
- Never change a primary key (ADR 020).
- Resolve defaults once per row when a generator gives each row its own value, such as `uuid()`. `now()` is shared across one call.

A generated value can be a foreign key or a field other rows reference. Tests for a write path cover those fields, not only plain columns.

## Code that scales with the store

Tests use a handful of rows; users have many thousands.

- Don't scan a whole store once per row or per outbox entry. Read once and index the result in memory, or use an IndexedDB index.
- Don't spread an unbounded array into function arguments (`rows.push(...batch)`, `Math.max(...values)`). Large arrays throw `RangeError`. Use a loop or `concat`.
- A missing index makes a query fall back to a full scan without an error. Check that the index you expect exists.

## Callbacks and errors

- A throwing listener or subscriber must not replace the error you were reporting. Deliver events in a `try`, and rethrow the original failure.
- Keep the cause when you wrap an error, including every inner error of an `AggregateError`.
- Resolve an injected dependency, such as the `indexedDB` factory, once, and reuse it for the matching cleanup.

## Browser-safe code only

Runtime packages run in the browser. Don't import `node:*` modules or packages that need them. Use Web APIs instead, for example `crypto.subtle` or `crypto.randomUUID()` instead of `node:crypto`. Vitest runs in Node and `tsc` sees the types, so neither catches this; only the Playwright suites do. If every Playwright spec fails at fixture setup, suspect a client-initialization crash and read the page's error alert.

## Testing

`fake-indexeddb` doesn't model transaction auto-commit timing faithfully. When a change depends on transaction lifetime, add or run a browser test in `apps/prisma-orm-usage/tests` (`pnpm test:prisma-idb-e2e`).
