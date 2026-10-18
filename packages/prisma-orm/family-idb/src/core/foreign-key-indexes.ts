import { keyPathFields } from "@prisma-idb/target-idb/pack";
import type { IdbIndexNode, IdbModelNode } from "./contract-definition";

/**
 * The index every foreign-key field gets, because IndexedDB has no joins and a
 * relation read is an index lookup on the foreign key. Each index is named for
 * its field. A field is skipped when a declared index has that name and indexes
 * that field alone, when a client projection excludes it, or when every relation using it sets
 * `index: false`. A field that is neither declared nor excluded still gets an
 * index, so the validator reports it instead of the relation passing silently.
 *
 * The validator and the builder both call this, so an index the builder adds is
 * checked like a declared one.
 */
export function foreignKeyIndexes(model: IdbModelNode): IdbIndexNode[] {
  const excluded = new Set(model.exclusions?.fields);
  const taken = new Map(model.indexes.map((node) => [node.name, node]));
  const added: IdbIndexNode[] = [];
  for (const relation of model.relations) {
    if (relation.cardinality === "1:N" || relation.index === false) continue;
    for (const field of relation.localFields) {
      if (excluded.has(field)) continue;
      const existing = taken.get(field);
      const fields = existing ? keyPathFields(existing.keyPath) : [];
      if (fields.length === 1 && fields[0] === field) continue;
      // Keep a conflicting name so validation reports it and checks the needed index too.
      const index = { name: field, keyPath: field, unique: false };
      taken.set(field, index);
      added.push(index);
    }
  }
  return added;
}
