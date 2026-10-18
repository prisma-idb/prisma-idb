import type { IdbIndexNode, IdbModelNode } from "./contract-definition";

/**
 * The index every foreign-key field gets, because IndexedDB has no joins and a
 * relation read is an index lookup on the foreign key. Each index is named for
 * its field. A field is skipped when a declared index already has that name,
 * when the field is not on the model (a client projection can exclude it), or
 * when every relation using it sets `index: false`.
 *
 * The validator and the builder both call this, so an index the builder adds is
 * checked like a declared one.
 */
export function foreignKeyIndexes(model: IdbModelNode): IdbIndexNode[] {
  const fieldNames = new Set(model.fields.map((field) => field.name));
  const taken = new Set(model.indexes.map((node) => node.name));
  const added: IdbIndexNode[] = [];
  for (const relation of model.relations) {
    if (relation.cardinality === "1:N" || relation.index === false) continue;
    for (const field of relation.localFields) {
      if (!fieldNames.has(field) || taken.has(field)) continue;
      taken.add(field);
      added.push({ name: field, keyPath: field, unique: false });
    }
  }
  return added;
}
