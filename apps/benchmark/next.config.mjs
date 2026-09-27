import path from "node:path";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(dirname, "../..");

/** @type {import('next').NextConfig} */
const config = {
  output: "export",
  // The kit ships TypeScript source, so Next has to compile it.
  transpilePackages: ["@prisma-idb/benchmark-kit"],
  reactStrictMode: true,
  images: { unoptimized: true },
  turbopack: {
    // With pnpm, Next can resolve from the workspace-level virtual store.
    // Pin root to monorepo root so Turbopack can resolve package paths safely.
    root: workspaceRoot,
  },
  outputFileTracingRoot: workspaceRoot,
  experimental: {
    optimizePackageImports: ["lucide-react", "recharts"],
    externalDir: true,
  },
};

export default config;
