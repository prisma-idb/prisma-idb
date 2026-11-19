---
name: port-prisma-behavior
description: Compare prisma-idb behavior with upstream Prisma and port it faithfully. Use when implementing a Prisma feature for IndexedDB, when unsure how Prisma or Prisma 8 behaves for a query, mutation, default, relation or migration, or when deciding whether a difference is intentional.
---

# Port behavior from upstream Prisma

The Prisma 8 packages should behave like upstream Prisma 8 unless an ADR says otherwise. The legacy generator should match the Prisma Client of its supported Prisma version. Read upstream code; don't guess from memory.

## 1. Find the right upstream version

- Prisma 8 packages: check the `@prisma/orm-*` dependency versions in the affected `package.json` (for example `8.0.0-rc.18`). Its tag (`v8.0.0-rc.18`) is the reference, not upstream `main`.
- Legacy generator: it supports Prisma 6 and 7 (`prisma` and `@prisma/client` peer ranges in `packages/generator/package.json`).

## 2. Read upstream code

Upstream Prisma, including Prisma 8, lives in `prisma/orm` (`prisma/prisma` redirects there).

- If `vendor/prisma` exists, it is a local, gitignored clone. Compare against the matching tag, not whatever is checked out: `git -C vendor/prisma fetch --tags`, then `git -C vendor/prisma show <tag>:<path>`.
- Without a local clone, read files at a tag with `gh api "repos/prisma/orm/contents/<path>?ref=<tag>" --jq .content | base64 -d`, or search with `gh search code --repo prisma/orm`.
- For Prisma 6 and 7 behavior, also see `prisma/prisma-engines` (query engine semantics) and the Prisma docs.
- Mongo-family code (`2-mongo-family`) is often the closest model for IndexedDB, since both are document stores.

Look for the behavior in three places: the public types (what input is accepted), the runtime (what it does) and upstream tests (edge cases and error codes).

## 3. Decide

- **Same behavior is possible**: port it. Match error codes, defaults and edge cases. Mirror the upstream tests that matter.
- **IndexedDB can't do it, or it would be misleading**: reject the input clearly (a validation error or a type error), rather than doing something approximately similar. Prefer an explicit unsupported error over silent emulation.
- **We choose to differ**: record it in an ADR (`write-adr` skill), and in the docs page for that feature.

## 4. Cite

In ADRs, link the upstream file at a commit SHA; the `adrs` rule requires it. In PR descriptions, a commit SHA or a release tag is fine. Never link a branch. In code comments, state the behavior directly; a link is fine when it saves a long explanation.
