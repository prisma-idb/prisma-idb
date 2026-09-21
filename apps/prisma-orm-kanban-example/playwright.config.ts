/// <reference types="node" />

import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./test",
  testMatch: "**/*.{e2e,spec}.{ts,js}",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : 4,
  reporter: process.env.CI ? "list" : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:4176",
    trace: "on-first-retry",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "pnpm build && pnpm exec vite preview --host 127.0.0.1 --port 4176",
    port: 4176,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    // Gates src/lib/server/test-auth.ts + /api/test/session — better-auth's
    // testUtils plugin, used to mint signed-in sessions without going
    // through the real login UI for tests that don't need to exercise it.
    env: { PLAYWRIGHT_TEST_UTILS: "1" },
  },
});
