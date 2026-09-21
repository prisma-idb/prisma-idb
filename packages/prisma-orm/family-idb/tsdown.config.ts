import { defineConfig } from "tsdown";

export default defineConfig({
  entry: [
    "src/exports/pack.ts",
    "src/exports/control.ts",
    "src/exports/contract-ts.ts",
    "src/exports/contract-psl.ts",
    "src/exports/config-types.ts",
    "src/exports/cli.ts",
    "src/bin/prisma-idb.ts",
  ],
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
