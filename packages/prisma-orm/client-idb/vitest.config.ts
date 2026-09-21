import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["fake-indexeddb/auto"],
    testTimeout: 30_000,
  },
});
