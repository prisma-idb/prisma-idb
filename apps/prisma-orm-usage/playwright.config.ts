/// <reference types="node" />

import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env["CI"],
  retries: process.env["CI"] ? 1 : 0,
  workers: process.env["CI"] ? 1 : 4,
  reporter: process.env["CI"] ? "list" : [["list"], ["html", { open: "never" }]],
  use: { trace: "on-first-retry", video: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "pnpm build && pnpm preview --port 4173",
    port: 4173,
    reuseExistingServer: !process.env["CI"],
  },
});
