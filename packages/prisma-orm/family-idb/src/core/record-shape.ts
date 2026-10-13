import type {
  ApplicationDomainNamespace,
  ContractField,
  ContractFieldType,
} from "@prisma/orm-framework/contract/types";
import type { IdbRecordField, IdbRecordFieldType, IdbRecordShape } from "@prisma-idb/target-idb/pack";

type ShapeDefinitions = Pick<ApplicationDomainNamespace, "enum" | "valueObjects">;

function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function buildType(
  type: ContractFieldType,
  definitions: ShapeDefinitions,
  ancestors: readonly string[]
): IdbRecordFieldType {
  if (type.kind === "scalar") return { ...type };
  if (type.kind === "union") {
    return { kind: "union", members: type.members.map((member) => buildType(member, definitions, ancestors)) };
  }
  const valueObject = definitions.valueObjects?.[type.name];
  if (!valueObject) throw new Error(`Unknown value object "${type.name}" in IDB record shape`);
  if (ancestors.includes(type.name)) throw new Error(`Recursive value object "${type.name}" in IDB record shape`);
  return {
    kind: "valueObject",
    name: type.name,
    fields: buildFields(valueObject.fields, definitions, [...ancestors, type.name]),
  };
}

function buildFields(
  fields: Record<string, ContractField>,
  definitions: ShapeDefinitions,
  ancestors: readonly string[]
): Record<string, IdbRecordField> {
  return Object.fromEntries(
    Object.entries(fields)
      .sort(([a], [b]) => compareNames(a, b))
      .map(([name, field]) => {
        const ref = field.valueSet;
        let valueSet: IdbRecordField["valueSet"];
        if (ref) {
          if (ref.plane !== "domain" || ref.entityKind !== "enum" || ref.spaceId !== undefined) {
            throw new Error(`Unsupported value set "${ref.entityName}" in IDB record shape`);
          }
          const entry = definitions.enum?.[ref.entityName];
          if (!entry) throw new Error(`Unknown enum "${ref.entityName}" in IDB record shape`);
          valueSet = {
            name: ref.entityName,
            codecId: entry.codecId,
            members: [...entry.members].sort((a, b) => compareNames(a.name, b.name)),
          };
        }
        return [
          name,
          {
            type: buildType(field.type, definitions, ancestors),
            nullable: field.nullable,
            ...(field.many ? { many: true as const } : {}),
            ...(field.dict ? { dict: true as const } : {}),
            ...(valueSet ? { valueSet } : {}),
          },
        ];
      })
  );
}

/**
 * Resolves a model's decoding shape into storage metadata before hashing.
 * Field and enum member order is canonical; compound key and union order stays significant.
 * Only referenced enums and value objects contribute to the stored shape.
 */
export function buildRecordShape(
  model: string,
  fields: Record<string, ContractField>,
  definitions: ShapeDefinitions
): IdbRecordShape {
  return { model, fields: buildFields(fields, definitions, []) };
}
