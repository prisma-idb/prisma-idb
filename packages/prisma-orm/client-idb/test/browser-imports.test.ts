/// <reference types="node" />
/**
 * The framework modules the auto-migrating client bundles for the browser import nothing from Node,
 * and every module the published client imports at runtime is installed with it.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import tsdownConfig from "../tsdown.config";
import packageJson from "../package.json";

const entries = [
  "@prisma/orm-toolchain/migration-tools/migration-graph",
  "@prisma/orm-toolchain/migration-tools/constants",
];
// `migration-tools/hash` is left out on purpose: it uses `node:crypto`, so the client hashes with
// its own WebCrypto copy in `src/core/migration-hash.ts`.

/** Every module specifier a file imports or re-exports from, with template-string noise ignored. */
function specifiersOf(source: string): string[] {
  return [...source.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*["']([^"'`$\s]+)["']/g)].map((match) => match[1]!);
}

/** Follows relative imports from `entry`, returning the files visited and each file's bare specifiers. */
function reachableFrom(entry: string): { files: Set<string>; bare: Map<string, string[]> } {
  const bare = new Map<string, string[]>();
  const seen = new Set<string>();
  const stack = [fileURLToPath(import.meta.resolve(entry))];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of specifiersOf(readFileSync(file, "utf8"))) {
      if (specifier.startsWith(".")) stack.push(resolve(dirname(file), specifier));
      else bare.set(file, [...(bare.get(file) ?? []), specifier]);
    }
  }
  return { files: seen, bare };
}

describe("browser-bundled framework modules", () => {
  it("finds import specifiers in the module graph (so an empty result cannot pass vacuously)", () => {
    expect(specifiersOf('import { a } from "node:fs";\nexport { b } from "./b.mjs";')).toEqual(["node:fs", "./b.mjs"]);
  });

  for (const entry of entries) {
    it(`${entry} reaches no node: module`, () => {
      const { files, bare } = reachableFrom(entry);
      expect(files.size).toBeGreaterThan(0);
      const nodeImports = [...bare.values()].flat().filter((specifier) => specifier.startsWith("node:"));
      expect(nodeImports).toEqual([]);
    });
  }
});

/** The package a bare specifier names: `@scope/name/sub` → `@scope/name`, `name/sub` → `name`. */
function packageOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

/** Bare specifiers of runtime imports and re-exports in `source`, skipping `import type` and `export type`. */
function runtimeSpecifiersOf(source: string): string[] {
  return [...source.matchAll(/^\s*(?:import|export)\s+(?!type\b)[^;]*?\bfrom\s*["']([^"'.][^"']*)["']/gm)].map(
    (match) => match[1]!
  );
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? sourceFiles(join(dir, entry.name)) : entry.name.endsWith(".ts") ? [join(dir, entry.name)] : []
  );
}

describe("runtime imports of the published client", () => {
  const bundled = [(tsdownConfig as { deps: { alwaysBundle: (string | RegExp)[] } }).deps.alwaysBundle].flat();
  const installed = new Set(Object.keys(packageJson.dependencies));
  const isBundled = (specifier: string) =>
    bundled.some((rule) => (typeof rule === "string" ? rule === specifier : rule.test(specifier)));

  it("finds runtime imports and skips type-only ones", () => {
    expect(
      runtimeSpecifiersOf('import type { A } from "a";\nimport { b } from "b/sub";\nexport { c } from "@s/c/x";')
    ).toEqual(["b/sub", "@s/c/x"]);
    expect(isBundled("@prisma/orm-toolchain/migration-tools/migration-graph")).toBe(true);
    expect(isBundled("@prisma/orm-toolchain/migration-tools/hash")).toBe(false);
  });

  it("imports only dependencies, or modules the build bundles", () => {
    const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
    const missing = sourceFiles(srcDir).flatMap((file) =>
      runtimeSpecifiersOf(readFileSync(file, "utf8"))
        .filter((specifier) => !specifier.startsWith("node:"))
        .filter((specifier) => packageOf(specifier) !== packageJson.name)
        .filter((specifier) => !installed.has(packageOf(specifier)) && !isBundled(specifier))
        .map((specifier) => `${file.slice(srcDir.length + 1)}: ${specifier}`)
    );
    expect(missing).toEqual([]);
  });
});
