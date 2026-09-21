import prettier from "eslint-config-prettier";
import { fileURLToPath } from "node:url";
import { defineConfig } from "eslint/config";
import { includeIgnoreFile } from "@eslint/compat";
import js from "@eslint/js";
import svelte from "eslint-plugin-svelte";
import globals from "globals";
import ts from "typescript-eslint";
import nextVitals from "eslint-config-next/core-web-vitals";

const gitignorePath = fileURLToPath(new URL("./.gitignore", import.meta.url));

export default defineConfig([
  includeIgnoreFile(gitignorePath),
  { ignores: ["**/src/lib/components/ui/**"] },
  // Prisma 8 emits generated contract & migration artifacts under the
  // app's prisma/ and migrations/ folders. They're checked in for
  // reproducibility but shouldn't be linted (they use `{}` etc. by design).
  {
    ignores: [
      // contract emit artifacts (contract.json + contract.d.ts) — includes
      // ADR 012 dual-projection outputs (contract.server.json/.d.ts, emitted
      // alongside the default client contract.json/.d.ts from the same
      // schema with `projection: "full"`)
      "**/src/lib/prisma/contract*.d.ts",
      "**/src/lib/prisma/contract*.json",
      // same artifacts, ADR 212 contract-space package layout (extension
      // packages keep contract source directly under src/, no lib/prisma/)
      "**/src/contract*.d.ts",
      "**/src/contract*.json",
      // migration package artifacts — all *.d.ts and *.json files inside
      // migrations/<space>/<pkg>/; migration.ts is intentionally left lintable
      // since it's the human-editable scaffold.
      "**/migrations/**/*.d.ts",
      "**/migrations/**/*.json",
      // same artifacts, kanban example's distinct Postgres migration
      // lineage (migrations-postgres/, not migrations/ — see
      // prisma.config.postgres.ts's header for why it's separate)
      "**/migrations-postgres/**/*.d.ts",
      "**/migrations-postgres/**/*.json",
      // generated Postgres schema artifacts
      "**/schema.postgres.generated.*",
      // sync-server-sql's test fixture contract, regenerated on every
      // `pnpm contract:emit:postgres` — see its prisma.config.ts
      "**/test/fixtures/schema.generated.*",
    ],
  },
  js.configs.recommended,
  ...ts.configs.recommended,
  ...svelte.configs.recommended,
  prettier,
  ...svelte.configs.prettier,
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
      "no-undef": "off",
    },
  },
  // Svelte-specific config
  {
    files: ["**/*.svelte", "**/*.svelte.ts", "**/*.svelte.js"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        extraFileExtensions: [".svelte"],
        parser: ts.parser,
      },
    },
  },
  // Next.js/React config for docs and benchmark apps only (scoped with files property)
  ...nextVitals.map((config) => {
    const files = config.files ?? ["**/*.{js,jsx,mjs,ts,tsx,mts,cts}"];
    return {
      ...config,
      files: files.map((pattern) => `apps/{docs,benchmark}/src/${pattern}`),
    };
  }),
]);
