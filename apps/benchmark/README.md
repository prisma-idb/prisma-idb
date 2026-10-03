# Benchmark App

Local-first benchmark dashboard for Prisma IDB generated clients.

## Commands

- `pnpm --filter @prisma-idb/benchmark dev`
- `pnpm --filter @prisma-idb/benchmark build`
- `pnpm --filter @prisma-idb/benchmark start`
- `pnpm --filter @prisma-idb/benchmark benchmark:ci`
- `pnpm --filter @prisma-idb/benchmark benchmark:compare --baseline ./.benchmark-results/baseline.json --current ./.benchmark-results/current.json --threshold 10`

## What it measures (MVP)

- CRUD: create user, createMany todo, updateMany todo, deleteMany todo
- Query/filter: findMany by completion, findMany with title contains
- Read patterns: sorted reads, paginated reads, and relation include reads

## Output artifacts

- JSON export
- Local run history persisted in browser storage

## Notes

- Benchmarks run fully in the browser against IndexedDB.
- Results are environment-specific; compare runs on the same machine/browser profile.

## CI Regression Gate

- CI runs benchmarks in headless Chromium via Playwright using `/?autoStart` with config query params.
- PR benchmark comparisons run the PR head and PR base commit on the same GitHub runner (head, base, base, head, with each tree's two runs pooled) to reduce VM-to-VM and run-order variance.
- Latest benchmark snapshot is published from CI to a public `benchmark-data` branch as `latest.json` after successful runs on `main`.
- Docs fetch that snapshot at runtime; if it is unavailable, the page shows an empty state instead of stale data.
- PR checks do **not** trust the baseline file from the PR branch; they benchmark the PR base commit directly using the same config.
- PR runs compare current results against baseline and fail only when the bootstrap 95% CI lower bound of median latency delta exceeds the threshold.
- If baseline and current runs have insufficient or mismatched sample data, the comparison is reported as advisory instead of enforcing.
- Newly added benchmark operations are reported in PR comments but do not fail the gate; removing baseline operations fails the gate.
- CI posts one sticky PR comment shared with the prisma-orm suite, with a collapsible per-operation delta table for each suite.
