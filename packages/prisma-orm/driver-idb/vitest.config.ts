import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Injects globalThis.indexedDB (and all IDB* globals) via fake-indexeddb.
    // Each test file gets its own fakeIndexedDB instance.
    setupFiles: ["fake-indexeddb/auto"],
    testTimeout: 30_000,
  },
});
