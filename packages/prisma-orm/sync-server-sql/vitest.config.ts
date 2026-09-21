import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 30_000,
    setupFiles: ["./test/setup.ts"],
    // Tests share one real Postgres database (test/helpers.ts) and reset it
    // with a TRUNCATE between each test — cross-file parallelism would race
    // that reset against another file's in-flight assertions.
    fileParallelism: false,
  },
});
