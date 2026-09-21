/// <reference types="node" />

import { defineConfig } from "@playwright/test";

export default defineConfig({
  webServer: { command: "pnpm exec prisma db push && pnpm build && pnpm preview", port: 4173 },
  testDir: "test",
  use: { baseURL: "http://localhost:4173" },
  reporter: "html",
  fullyParallel: true,
  workers: process.env.CI ? 1 : undefined,
});
