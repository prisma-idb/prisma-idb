import { domainModelsAtDefaultNamespace } from "@prisma/orm-framework/contract/types";
import type { SyncServerContract } from "./ownership-dag";

/**
 * Every structural path of `N:1` relation names from `modelName` back to
 * `rootModel` — not just the shortest. A record legitimately reachable
 * through relation A *or* relation B is authorized either way (ADR 014's
 * "any one path, not shortest path"), so callers must check all of them.
 *
 * Sorted shortest-first, then lexicographically by relation-name chain, for
 * deterministic output — matches the old generator's `buildAllAuthorizationPaths`
 * precedent, minus the "prefer required" tiebreak (this DAG doesn't
 * distinguish nullable from required FKs; see ADR 014's rationale).
 */
export function resolveAuthorizationPaths(
  contract: SyncServerContract,
  rootModel: string,
  modelName: string
): readonly (readonly string[])[] {
  if (modelName === rootModel) return [];

  const models = domainModelsAtDefaultNamespace(contract.domain);
  const paths: string[][] = [];

  const dfs = (current: string, path: string[], visited: Set<string>): void => {
    const model = models[current];
    if (!model) return;

    for (const [relationName, relation] of Object.entries(model.relations)) {
      if (relation.cardinality !== "N:1") continue;
      const target = relation.to.model;
      if (!models[target] || visited.has(target)) continue;

      path.push(relationName);
      if (target === rootModel) {
        paths.push([...path]);
      } else {
        visited.add(target);
        dfs(target, path, visited);
        visited.delete(target);
      }
      path.pop();
    }
  };

  dfs(modelName, [], new Set([modelName]));

  return paths.sort((a, b) => a.length - b.length || a.join(".").localeCompare(b.join(".")));
}
