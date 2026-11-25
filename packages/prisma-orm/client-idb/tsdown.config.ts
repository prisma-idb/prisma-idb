import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/exports/orm.ts", "src/exports/client.ts", "src/exports/client-auto.ts", "src/exports/internal.ts"],
  format: ["esm"],
  dts: {
    enabled: true,
    sourcemap: true,
  },
  sourcemap: true,
  deps: {
    neverBundle: true,
    // The auto-migrating client plans its path with the toolchain's migration graph. That module
    // and the one it imports are browser-safe, but the toolchain package is a build-time tool with
    // heavy dependencies, so bundle the two modules instead of making it a runtime dependency.
    alwaysBundle: [/^@prisma\/orm-toolchain\/migration-tools\/(migration-graph|constants)$/],
  },
  tsconfig: "tsconfig.prod.json",
});
