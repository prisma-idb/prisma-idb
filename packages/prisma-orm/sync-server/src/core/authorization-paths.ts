import { domainModelsAtDefaultNamespace } from "@prisma/orm-framework/contract/types";
import type { GetKeyField } from "./sync-server";
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

/** One outgoing tenant parent, with alternate routes to the caller's root. */
export interface ParentReferenceCheck {
  readonly relation: string;
  readonly localField: string;
  readonly nullable: boolean;
  readonly paths: readonly (readonly string[])[];
}

/**
 * Groups root paths by their first parent. Every populated group must pass;
 * alternate routes within a group retain any-path authorization.
 * @throws {Error} If a checked path is not a single-field FK-to-key join.
 */
export function resolveParentReferenceChecks(
  contract: SyncServerContract,
  getKeyField: GetKeyField,
  modelName: string,
  paths: readonly (readonly string[])[]
): readonly ParentReferenceCheck[] {
  const models = domainModelsAtDefaultNamespace(contract.domain);
  const groups = new Map<string, { relation: string; localField: string; nullable: boolean; paths: string[][] }>();
  for (const path of paths) {
    if (path.length === 0) throw new Error(`Empty tenant parent path for "${modelName}".`);
    let current = modelName;
    for (const relationName of path) {
      const model = models[current];
      const relation = model?.relations[relationName];
      if (
        !relation ||
        relation.cardinality !== "N:1" ||
        !("on" in relation) ||
        relation.on.localFields.length !== 1 ||
        relation.on.targetFields.length !== 1 ||
        relation.on.targetFields[0] !== getKeyField(contract, relation.to.model) ||
        !model?.fields[relation.on.localFields[0]!]
      ) {
        throw new Error(
          `Unsupported tenant parent join "${current}.${relationName}": expected a single-field FK to the parent's key.`
        );
      }
      if (current === modelName) {
        const localField = relation.on.localFields[0]!;
        let group = groups.get(relationName);
        if (!group) {
          group = {
            relation: relationName,
            localField,
            nullable: model.fields[localField]!.nullable === true,
            paths: [],
          };
          groups.set(relationName, group);
        }
        group.paths.push([...path]);
      }
      current = relation.to.model;
    }
  }
  return [...groups.values()];
}
