import type { IdbIndexNode, IdbModelNode } from "./contract-definition";

/**
 * The index every foreign-key field gets, because IndexedDB has no joins and a
 * relation read is an index lookup on the foreign key. Each index is named for
 * its field. A field is skipped when a declared index already has that name,
 * when a client projection excludes it, or when every relation using it sets
 * `index: false`. A field that is neither declared nor excluded still gets an
 * index, so the validator reports it instead of the relation passing silently.
 *
 * The validator and the builder both call this, so an index the builder adds is
 * checked like a declared one.
 */
export function foreignKeyIndexes(model: IdbModelNode): IdbIndexNode[] {
  const excluded = new Set(model.exclusions?.fields);
  const taken = new Set(model.indexes.map((node) => node.name));
  const added: IdbIndexNode[] = [];
  for (const relation of model.relations) {
    if (relation.cardinality === "1:N" || relation.index === false) continue;
    for (const field of relation.localFields) {
      if (excluded.has(field) || taken.has(field)) continue;
      taken.add(field);
      added.push({ name: field, keyPath: field, unique: false });
    }
  }
  return added;
}
