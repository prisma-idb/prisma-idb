import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/exports/index.ts"],
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
