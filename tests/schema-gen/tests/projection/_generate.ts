/// <reference types="node" />

import { execa } from "execa";
import fs from "fs/promises";
import path from "path";

const projectionDir = path.resolve(__dirname);
const tscBin = path.resolve(__dirname, "../../node_modules/.bin/tsc");

/** Where a generated project lives. `generated/` is git-ignored. */
export interface GeneratedProject {
  /** The directory that holds the copied schema and both outputs. */
  readonly dir: string;
  /** The `prisma-idb` output directory (`client/`, `server/`, `validators.ts`). */
  readonly idbDir: string;
}

/** Absolute path to a fixture schema, given a path such as `valid/user-board-todo.prisma`. */
export function schemaPath(schemaFile: string): string {
  return path.join(projectionDir, "schemas", schemaFile);
}

/**
 * Runs the real `prisma generate` for one fixture schema and returns where the output landed.
 *
 * Each schema gets its own directory so test files can run in parallel. The fixture's relative
 * `output` paths are rewritten to point into that directory, which sits under `tests/` so the
 * generated modules resolve `zod`, `idb` and `uuid` from this package's `node_modules`.
 */
export async function generateProject(schemaFile: string): Promise<GeneratedProject> {
  const dir = path.join(projectionDir, "generated", path.basename(schemaFile, ".prisma"));
  const source = await fs.readFile(schemaPath(schemaFile), "utf8");

  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "schema.prisma"), source.replaceAll('"../../generated/', '"./'));
  await execa("pnpm", ["exec", "prisma", "generate", "--schema", path.join(dir, "schema.prisma")]);

  return { dir, idbDir: path.join(dir, "prisma-idb") };
}

/**
 * Type-checks every generated module (both the Prisma Client and the IndexedDB client) under
 * `strict`. Resolves with the compiler output, which is empty when the project compiles.
 */
export async function typeCheck(project: GeneratedProject): Promise<string> {
  const tsconfig = {
    compilerOptions: {
      target: "ESNext",
      module: "ESNext",
      moduleResolution: "bundler",
      lib: ["ESNext", "DOM"],
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      types: [],
    },
    include: ["prisma/**/*.ts", "prisma-idb/**/*.ts"],
  };
  const configPath = path.join(project.dir, "tsconfig.json");
  await fs.writeFile(configPath, JSON.stringify(tsconfig));

  const result = await execa(tscBin, ["-p", configPath], { reject: false });
  return result.stdout;
}
