# prisma-orm benchmark

Wall-clock benchmark for `@prisma-idb/client-idb`, run in real Chromium.

It complements the plan-shape gate in
`packages/prisma-orm/client-idb/test/plan-shape-gate.test.ts`:

- The **plan-shape gate** runs in Node on `fake-indexeddb`. It counts what
  IndexedDB was asked to do (values deserialized, keys read, index or full
  scan). The counts are exact, so it blocks CI on any change.
- **This benchmark** checks that those counts turn into real time in a real
  browser, where each deserialized value and each cursor step has a cost that
  `fake-indexeddb` doesn't model.

## What it measures

The operations in `src/operations.ts` use the same query shapes as the
plan-shape gate:

- **Controls**: a full scan with no filter and an equality on an unindexed
  field. No index can help these.
- **Regression guards**: shapes an index already serves, such as equality on
  an indexed field, an OR of indexed equalities, `count()` and `include()`.
- **Targets**: shapes an index could serve but that scan the whole store
  today, such as ranges, `in()`, compound-index matches, and the foreign-key
  lookups behind cascades and restrict checks.

The database is seeded once per run, with 5000 rows per store by default.
Read operations reuse it. Mutating operations insert the rows they delete in
their untimed `prepare` step and delete the rows they create in their untimed
`cleanup` step, so store sizes stay constant across samples. The runner takes
samples round-robin across operations, so no operation may leave data behind
for the next one. `pnpm test:unit` checks this against `fake-indexeddb`.

## Running it

```bash
pnpm turbo run build --filter=@prisma-idb/prisma-orm-benchmark^...
pnpm --filter @prisma-idb/prisma-orm-benchmark benchmark:ci
```

`BENCHMARK_DATASET_SIZE`, `BENCHMARK_WARMUP_RUNS`, `BENCHMARK_MEASURED_RUNS`
and `BENCHMARK_RESULT_PATH` override the defaults. To run it by hand, start
`pnpm dev` and use the form on the page.

In CI, `.github/workflows/benchmark.yml` runs the suite on the PR head and
the PR base on the same runner, twice each in the order head, base, base,
head, and pools each tree's runs. It then gates on a bootstrap 95% confidence
interval of the median change (see `@prisma-idb/benchmark-kit`).

## Changing the schema

`src/contract.server.ts` is the source. After editing it, run
`pnpm contract:emit` and commit the regenerated `src/contract.json`. The
browser loads the JSON, because `defineContract` needs `node:crypto`.
