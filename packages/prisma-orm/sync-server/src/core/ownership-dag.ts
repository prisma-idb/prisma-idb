import type { Contract } from "@prisma/orm-framework/contract/types";
import { domainModelsAtDefaultNamespace } from "@prisma/orm-framework/contract/types";

/**
 * The contract shape `sync-server` operates on — any family's `Contract`
 * (see ADR 014's "Genuinely family-agnostic"). The DAG only ever walks
 * `contract.domain` (relations, model names), which is framework-level and
 * identical in shape across IDB, SQL, Mongo, or any future family — nothing
 * here reads `contract.storage` except through the injectable `getKeyField`
 * resolver in `sync-server.ts`, which is the one place storage shape
 * actually varies by family.
 */
export type SyncServerContract = Contract;

/**
 * The ownership graph: `edges.get(model)` is every model reachable from
 * `model` via one of its own `N:1` relations (the models it could be
 * "owned by"). Built once, at `createSyncServer()` construction — never
 * per-request (ADR 014).
 */
export interface OwnershipDag {
  readonly rootModel: string;
  readonly edges: ReadonlyMap<string, ReadonlySet<string>>;
  /** Model names present in the client-projected contract (ADR 012). */
  readonly clientModels: ReadonlySet<string>;
}

/**
 * Builds the ownership DAG from the full server-side contract, walking
 * `model.relations` for every domain model. Throws if the graph has a
 * cycle, or if any *client* model (a model that survives ADR 012's
 * projection) has no chain of owning relations back to `rootModel`.
 *
 * Server-only models (present in `contract` but not `clientContract`) are
 * exempt from the reachability requirement — they can never appear in an
 * outbox event or a pull scope check, so there's nothing to authorize. They
 * still count as graph nodes, since a client model's authorization chain
 * may legitimately pass through one (see ADR 014's "why the full graph").
 */
export function buildOwnershipDag(
  contract: SyncServerContract,
  clientContract: SyncServerContract,
  rootModel: string
): OwnershipDag {
  const models = domainModelsAtDefaultNamespace(contract.domain);
  const clientModels = new Set(Object.keys(domainModelsAtDefaultNamespace(clientContract.domain)));

  if (!(rootModel in models)) {
    throw new Error(`Root model "${rootModel}" is not present in the contract's domain models.`);
  }
  if (!clientModels.has(rootModel)) {
    throw new Error(`Root model "${rootModel}" is not present in the client contract's domain models.`);
  }

  const edges = new Map<string, Set<string>>();
  for (const modelName of Object.keys(models)) {
    edges.set(modelName, new Set());
  }
  for (const [modelName, model] of Object.entries(models)) {
    for (const relation of Object.values(model.relations)) {
      if (relation.cardinality === "N:1" && models[relation.to.model]) {
        edges.get(modelName)?.add(relation.to.model);
      }
    }
  }

  validateAcyclic(edges);
  validateClientReachability(edges, clientModels, rootModel);

  return { rootModel, edges, clientModels };
}

function validateAcyclic(edges: ReadonlyMap<string, ReadonlySet<string>>): void {
  const state = new Map<string, "visiting" | "done">();

  function visit(node: string): void {
    if (state.get(node) === "done") return;
    if (state.get(node) === "visiting") {
      throw new Error(`Cycle detected in the ownership graph involving model "${node}".`);
    }
    state.set(node, "visiting");
    for (const neighbor of edges.get(node) ?? []) {
      visit(neighbor);
    }
    state.set(node, "done");
  }

  for (const node of edges.keys()) {
    visit(node);
  }
}

function validateClientReachability(
  edges: ReadonlyMap<string, ReadonlySet<string>>,
  clientModels: ReadonlySet<string>,
  rootModel: string
): void {
  const reverseEdges = new Map<string, Set<string>>();
  for (const modelName of edges.keys()) {
    reverseEdges.set(modelName, new Set());
  }
  for (const [modelName, targets] of edges) {
    for (const target of targets) {
      reverseEdges.get(target)?.add(modelName);
    }
  }

  const visited = new Set<string>([rootModel]);
  const stack = [rootModel];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) continue;
    for (const neighbor of reverseEdges.get(current) ?? []) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        stack.push(neighbor);
      }
    }
  }

  for (const modelName of clientModels) {
    if (!visited.has(modelName)) {
      throw new Error(
        `Model "${modelName}" has no path of owning relations back to root model "${rootModel}". ` +
          `Add a relation chain to "${rootModel}", or exclude the model from the client contract if it shouldn't sync.`
      );
    }
  }
}
