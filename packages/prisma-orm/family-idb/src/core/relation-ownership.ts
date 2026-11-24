import { keyPathFields, sameFieldSet, sameJoinPairs } from "@prisma-idb/target-idb/pack";
import type { IdbContractDefinition, IdbModelNode, IdbRelationNode } from "./contract-definition";

/**
 * Which side of a join a to-one relation is on.
 *
 * - `owner` holds the foreign key: every `N:1`, and a `1:1` that points at the
 *   other model's primary key or whose inverse is a `1:N`.
 * - `inverse` is the referenced side of a one-to-one: a `1:1` whose join pairs
 *   with an `N:1` on the other model, or that joins on its own primary key.
 * - `undetermined` is a `1:1` that fits neither, so no foreign key backs it.
 */
export type ToOneSide = "owner" | "inverse" | "undetermined";

/** The relations on `target` that join back to `model` on the same fields, in reverse. */
function reciprocalRelations(
  model: IdbModelNode,
  relation: IdbRelationNode,
  target: IdbModelNode | undefined
): IdbRelationNode[] {
  return (target?.relations ?? []).filter(
    (inverse) =>
      inverse.to === model.modelName &&
      sameJoinPairs(inverse.localFields, inverse.targetFields, relation.targetFields, relation.localFields)
  );
}

/** Classify a to-one relation the way the client decides which side holds the foreign key. */
export function toOneSide(model: IdbModelNode, relation: IdbRelationNode, target: IdbModelNode | undefined): ToOneSide {
  if (relation.cardinality === "N:1") return "owner";
  const reciprocal = reciprocalRelations(model, relation, target);
  if (
    reciprocal.some((inverse) => inverse.cardinality === "N:1") ||
    sameFieldSet(relation.localFields, keyPathFields(model.key))
  ) {
    return "inverse";
  }
  if (
    (target !== undefined && sameFieldSet(relation.targetFields, keyPathFields(target.key))) ||
    reciprocal.some((inverse) => inverse.cardinality === "1:N")
  ) {
    return "owner";
  }
  return "undetermined";
}

/**
 * Fill in `nullable` on every to-one relation that leaves it out, as upstream
 * Prisma derives it. The side that holds the foreign key is optional exactly
 * when one of its foreign-key fields is optional. Any other `1:1` is optional,
 * because nothing in storage guarantees that the related row exists.
 */
export function withDerivedToOneNullability(definition: IdbContractDefinition): IdbContractDefinition {
  const byName = new Map(definition.models.map((model) => [model.modelName, model]));
  return {
    ...definition,
    models: definition.models.map((model) => ({
      ...model,
      relations: model.relations.map((relation) => {
        if (relation.cardinality === "1:N" || relation.nullable !== undefined) return relation;
        const side = toOneSide(model, relation, byName.get(relation.to));
        const nullable =
          side !== "owner" ||
          relation.localFields.some((name) => model.fields.find((field) => field.name === name)?.nullable === true);
        return { ...relation, nullable };
      }),
    })),
  };
}
