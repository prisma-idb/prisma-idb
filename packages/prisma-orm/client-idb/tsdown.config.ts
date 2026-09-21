import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/exports/orm.ts", "src/exports/client.ts", "src/exports/client-auto.ts"],
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
