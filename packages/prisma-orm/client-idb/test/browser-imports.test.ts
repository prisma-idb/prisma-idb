/// <reference types="node" />
/** The framework modules the auto-migrating client bundles for the browser import nothing from Node. */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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
