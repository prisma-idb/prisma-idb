import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/exports/pack.ts", "src/exports/control.ts", "src/exports/runtime.ts", "src/exports/migration.ts"],
  format: ["esm"],
  dts: {
    enabled: true,
    sourcemap: true,
  },
  sourcemap: true,
  deps: {
    neverBundle: true,
  },
  tsconfig: "tsconfig.prod.json",
});
