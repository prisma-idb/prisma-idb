import type { MigrationMetadata } from "@prisma/orm-toolchain/migration-tools/metadata";

/**
 * Minimal shape that {@link chainOrderByMetadata} needs from each package.
 *
 * Callers typically have richer types (ops, file paths) — just make sure
 * `dirName` and `metadata.from` are present.
 */
export interface ChainablePackage {
  readonly dirName: string;
  readonly metadata: Pick<MigrationMetadata, "from" | "to">;
}

/**
 * Walk an unordered set of migration packages by `metadata.from`/`to` edges
 * to produce a chain-ordered list. Starts at the package whose
 * `from === null` (the baseline) and follows each `to` to the next
 * package's matching `from`.
 *
 * Throws on:
 * - No baseline (no package with `from === null`)
 * - Multiple baselines (two packages with `from === null`)
 * - Broken edge (no package whose `from` matches the cursor)
 * - Cycle (revisited hash)
 * - Orphan package (package left unvisited after chain completes)
 */
export function chainOrderByMetadata<P extends ChainablePackage>(unordered: ReadonlyMap<string, P>): P[] {
  if (unordered.size === 0) return [];

  const byFrom = new Map<string | null, P>();
  for (const pkg of unordered.values()) {
    const from = pkg.metadata.from;
    const existing = byFrom.get(from);
    if (existing) {
      throw new Error(
        `Migration chain conflict: ${existing.dirName} and ${pkg.dirName} both ` +
          `declare from === ${JSON.stringify(from)}. The chain must be linear.`
      );
    }
    byFrom.set(from, pkg);
  }

  const ordered: P[] = [];
  const visited = new Set<string>();
  let cursor: string | null = null;
  while (true) {
    const next = byFrom.get(cursor);
    if (!next) {
      if (ordered.length === unordered.size) break; // chain complete
      const orphans = [...unordered.keys()].filter((d) => !visited.has(d));
      throw new Error(
        `Migration chain broken: no package declares from === ${JSON.stringify(cursor)}. ` +
          `Orphan package(s) not reachable from the baseline: ${orphans.join(", ")}. ` +
          "Either the migrations directory has been hand-edited or a package was " +
          "deleted; re-emit the affected migration with `node migration.ts`."
      );
    }
    if (visited.has(next.dirName)) {
      throw new Error(`Migration chain cycle detected at ${next.dirName}.`);
    }
    visited.add(next.dirName);
    ordered.push(next);
    cursor = next.metadata.to;
  }

  return ordered;
}
