import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/exports/control.ts", "src/exports/client.ts", "src/exports/schemas.ts"],
  format: ["esm"],
  dts: {
    enabled: true,
    sourcemap: true,
  },
  sourcemap: true,
  deps: {
    neverBundle: true,
  },
});
