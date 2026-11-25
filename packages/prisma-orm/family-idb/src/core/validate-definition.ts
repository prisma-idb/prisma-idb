import { keyPathFields, sameJoinPairs } from "@prisma-idb/target-idb/pack";
import type { IdbKeyPath } from "@prisma-idb/target-idb/pack";
import { foreignKeyIndexes } from "./foreign-key-indexes";
import type {
  IdbContractDefinition,
  IdbDefinitionPath,
  IdbFieldNode,
  IdbModelNode,
  IdbRelationNode,
} from "./contract-definition";

/** A surface-independent problem anchored to a named definition coordinate. */
export interface IdbDiagnostic {
  readonly code: `IDB_${string}`;
  readonly message: string;
  readonly at: IdbDefinitionPath;
}

/** Scalar names are reserved for built-in codecs on both authoring surfaces. */
const SCALAR_NAMES = new Set(["String", "Int", "Float", "Boolean", "DateTime", "BigInt", "Decimal", "Json", "Bytes"]);

/** A key path must name at least one distinct, non-empty field. Shared with raw contract validation. */
export function isWellFormedKeyPath(keyPath: unknown): keyPath is IdbKeyPath {
  if (typeof keyPath === "string") return keyPath !== "";
  if (!Array.isArray(keyPath) || keyPath.length === 0) return false;
  return (
    keyPath.every((field) => typeof field === "string" && field !== "") && new Set(keyPath).size === keyPath.length
  );
}

/** IDB's valid-key algorithm excludes booleans, bigints, and arbitrary JSON values. */
export function isValidIdbKeyCodec(codecId: string): boolean {
  return !["idb/bool@1", "idb/bigint@1", "idb/json@1"].includes(codecId);
}

/** Literal defaults must match the field's stored scalar type. */
export function literalValueMatchesCodec(value: string | number | boolean, codecId: string): boolean {
  switch (codecId) {
    case "idb/string@1":
      return typeof value === "string";
    case "idb/int32@1":
    case "idb/double@1":
    case "idb/decimal@1":
      return typeof value === "number";
    case "idb/bool@1":
      return typeof value === "boolean";
    default:
      return false;
  }
}

/** A local collector avoids threading mutable diagnostic arrays through each rule. */
type Report = (code: IdbDiagnostic["code"], message: string, at: IdbDefinitionPath) => void;

/** Validate every enum, including enums that a client projection will later discard. */
function validateEnums(definition: IdbContractDefinition, report: Report): void {
  for (const node of definition.enums) {
    const at = ["enums", node.name];
    if (SCALAR_NAMES.has(node.name)) {
      report(
        "IDB_ENUM_SCALAR_NAME_CONFLICT",
        `Enum "${node.name}" conflicts with the built-in scalar type of the same name.`,
        at
      );
    }
    if (node.members.length === 0) {
      report("IDB_ENUM_EMPTY", `Enum "${node.name}" must declare at least one member.`, at);
    }
    const seen = new Set<string>();
    for (const member of node.members) {
      if (seen.has(member.value)) {
        report(
          "IDB_ENUM_DUPLICATE_VALUE",
          `Enum "${node.name}" repeats stored value "${member.value}". Enum values must be unique.`,
          [...at, "members", member.name]
        );
      }
      seen.add(member.value);
    }
  }
}

/** Validate scalar/list shapes, literal defaults, and resolved execution generators. */
function validateField(
  model: IdbModelNode,
  field: IdbFieldNode,
  definition: IdbContractDefinition,
  report: Report
): void {
  const at = ["models", model.modelName, "fields", field.name];
  const label = `Field "${model.modelName}.${field.name}"`;
  if (field.unsupportedType !== undefined) {
    report(
      "IDB_UNSUPPORTED_FIELD_TYPE",
      `${label} has unsupported type "${field.unsupportedType}". Supported types: ${[...SCALAR_NAMES].join(", ")}.`,
      at
    );
    return;
  }
  if (field.list && field.nullable) {
    report("IDB_OPTIONAL_LIST", `${label}: A list field cannot be optional.`, at);
  }
  validateLiteralDefault(model, field, definition, report);
  validateExecutionDefault(model, field, report);
}

/** Validate defaults against enum membership and stored scalar types. */
function validateLiteralDefault(
  model: IdbModelNode,
  field: IdbFieldNode,
  definition: IdbContractDefinition,
  report: Report
): void {
  const at = ["models", model.modelName, "fields", field.name];
  const label = `Field "${model.modelName}.${field.name}"`;
  if (field.literalDefault !== undefined) {
    const defaultAt = [...at, "literalDefault"];
    if (field.list) {
      report("IDB_LIST_DEFAULT_UNSUPPORTED", `${label}: Only an empty list default ([]) is supported.`, defaultAt);
    } else if (field.enumName !== undefined) {
      if (
        !definition.enums
          .find((node) => node.name === field.enumName)
          ?.members.some((member) => member.value === field.literalDefault)
      ) {
        report(
          "IDB_INVALID_ENUM_DEFAULT",
          `${label} default is not a declared value of enum "${field.enumName}".`,
          defaultAt
        );
      }
    } else if (!literalValueMatchesCodec(field.literalDefault, field.codecId)) {
      report(
        "IDB_INVALID_DEFAULT_VALUE",
        `${label} has codec "${field.codecId}" but its default is a ${typeof field.literalDefault} literal. The literal default's JS type must match the field's declared type.`,
        defaultAt
      );
    }
  }
}

/** Validate generated defaults without depending on either surface's syntax. */
function validateExecutionDefault(model: IdbModelNode, field: IdbFieldNode, report: Report): void {
  const at = ["models", model.modelName, "fields", field.name];
  const label = `Field "${model.modelName}.${field.name}"`;
  const execution = field.executionDefault;
  if (!execution) return;
  if (field.list && field.literalDefault === undefined && execution.onCreate?.id === "literal") {
    const value = execution.onCreate.params?.["value"];
    if (!Array.isArray(value) || value.length !== 0) {
      report("IDB_LIST_DEFAULT_UNSUPPORTED", `${label}: Only an empty list default ([]) is supported.`, [
        ...at,
        "literalDefault",
      ]);
    }
  }
  if (!field.list && execution.onCreate?.id === "literal" && Array.isArray(execution.onCreate.params?.["value"])) {
    report("IDB_INVALID_DEFAULT_VALUE", `${label}: A scalar field cannot have a list default.`, [
      ...at,
      "literalDefault",
    ]);
  }

  // A primary key never changes, so no generator may rewrite one on update.
  if (execution.onUpdate !== undefined && keyPathFields(model.key).includes(field.name)) {
    report(
      "IDB_ON_UPDATE_ON_KEY_FIELD",
      `${label} is part of the model's primary key and cannot generate a value on update. Primary keys never change.`,
      at
    );
  }
  // Generator functions and tagged literals are checked against the field's codec
  // when they are read. `now()` in PSL `@default(now())` and the TypeScript `now()`
  // helper fills a field without a generator function, so it is checked here.
  if (
    execution.onCreate?.id === "timestampNow" &&
    (field.codecId !== "idb/date@1" || field.enumName !== undefined || field.list)
  ) {
    report("IDB_INVALID_DEFAULT_VALUE", `${label} uses now(), which requires a DateTime field.`, [
      ...at,
      "executionDefault",
      "onCreate",
    ]);
  }
}

/** Each model needs its own store: the contract keys stores and roots by store name, so a second model would replace the first. */
function validateStoreNames(definition: IdbContractDefinition, report: Report): void {
  const owners = new Map<string, string>();
  for (const model of definition.models) {
    const owner = owners.get(model.storeName);
    if (owner === undefined) {
      owners.set(model.storeName, model.modelName);
      continue;
    }
    report(
      "IDB_DUPLICATE_STORE_NAME",
      `Models "${owner}" and "${model.modelName}" both use store "${model.storeName}". Give one of them another store name.`,
      ["models", model.modelName, "storeName"]
    );
  }
}

/** Validate the primary key against the fields that survive projection. */
function validateKeys(model: IdbModelNode, report: Report): void {
  const at = ["models", model.modelName];
  const fields = new Map(model.fields.map((field) => [field.name, field]));
  const excluded = new Set(model.exclusions?.fields);
  const keys = keyPathFields(model.key);
  if (keys.length === 0) {
    report(
      "IDB_MISSING_ID",
      `Model "${model.modelName}" has no @id field. Add @id to exactly one scalar field, or @@id([...]) for a compound key.`,
      [...at, "key"]
    );
  } else if (!isWellFormedKeyPath(model.key)) {
    report("IDB_INVALID_ID", `Model "${model.modelName}" key has an empty field name or repeats a field name.`, [
      ...at,
      "key",
    ]);
  }
  for (const name of keys) {
    const field = fields.get(name);
    if (excluded.has(name)) {
      report(
        "IDB_CANNOT_EXCLUDE_KEY_FIELD",
        `Model "${model.modelName}" excludes its own key field "${name}". The client contract needs a primary key for every included model.`,
        [...at, "key"]
      );
    } else if (!field) {
      report("IDB_INVALID_ID", `Model "${model.modelName}" key field "${name}" is not declared in "fields".`, [
        ...at,
        "key",
      ]);
    } else {
      if (field.list)
        report("IDB_LIST_ID", `Field "${model.modelName}.${name}" is a list and cannot be part of a primary key.`, [
          ...at,
          "fields",
          name,
        ]);
      if (field.nullable)
        report("IDB_NULLABLE_ID", `Field "${model.modelName}.${name}" is a key field and cannot be nullable.`, [
          ...at,
          "fields",
          name,
        ]);
      if (!isValidIdbKeyCodec(field.codecId))
        report(
          "IDB_INVALID_KEY_TYPE",
          `Model "${model.modelName}" @id field "${name}" has type "${field.codecId}", which IndexedDB cannot use as a key. Every write would throw (DataError extracting the primary key). Use String, Int, Float, DateTime, Decimal, or Bytes instead.`,
          [...at, "fields", name]
        );
    }
  }
}

/** Validate secondary indexes, including the IndexedDB multiEntry restriction. */
function validateIndexes(model: IdbModelNode, report: Report): void {
  const at = ["models", model.modelName];
  const fields = new Map(model.fields.map((field) => [field.name, field]));
  const excluded = new Set(model.exclusions?.fields);
  // The builder indexes foreign keys, so the validator checks those indexes too.
  const seen = new Set<string>();
  for (const index of [...model.indexes, ...foreignKeyIndexes(model)]) {
    const indexAt = [...at, "indexes", index.name];
    if (seen.has(index.name)) {
      report(
        "IDB_INVALID_INDEX",
        `Model "${model.modelName}" index name "${index.name}" is declared more than once. An index named for a foreign-key field must index that field alone.`,
        indexAt
      );
    }
    seen.add(index.name);
    const names = keyPathFields(index.keyPath);
    if (!isWellFormedKeyPath(index.keyPath)) {
      report(
        "IDB_INVALID_INDEX",
        `Model "${model.modelName}" index "${index.name}" keyPath is empty or repeats a field name.`,
        indexAt
      );
    }
    if (index.multiEntry && names.length > 1) {
      report(
        "IDB_INVALID_INDEX",
        `Model "${model.modelName}" index "${index.name}" combines multiEntry with a compound keyPath. IndexedDB rejects this combination.`,
        indexAt
      );
    }
    for (const name of names) {
      const field = fields.get(name);
      if (excluded.has(name))
        report(
          "IDB_INDEX_ON_EXCLUDED_FIELD",
          `Model "${model.modelName}" index "${index.name}" references excluded field "${name}". Remove the index or the exclusion.`,
          indexAt
        );
      else if (!field)
        report(
          "IDB_INVALID_INDEX",
          `Model "${model.modelName}" index "${index.name}" references field "${name}", which is not declared in "fields".`,
          indexAt
        );
      else if (field.list)
        report(
          "IDB_LIST_INDEX",
          `Model "${model.modelName}" index "${index.name}" references list field "${name}". Indexes on list fields are not supported.`,
          indexAt
        );
      else if (!index.multiEntry && !isValidIdbKeyCodec(field.codecId)) {
        report(
          "IDB_INVALID_INDEX_KEY_TYPE",
          `Model "${model.modelName}" index "${index.name}" is keyed on "${name}" (type "${field.codecId}"), which IndexedDB cannot use as an index key. Records are silently omitted from the index on write, and any query against it throws at runtime. Use String, Int, Float, DateTime, Decimal, or Bytes instead.`,
          [...at, "fields", name]
        );
      }
    }
  }
}

/** Validate requests for IndexedDB's storage-level key generator. */
function validateAutoIncrement(model: IdbModelNode, report: Report): void {
  const keys = keyPathFields(model.key);
  for (const name of model.autoIncrementFields ?? []) {
    const at = ["models", model.modelName, "fields", name, "literalDefault"];
    const label = `Field "${model.modelName}.${name}"`;
    if (!keys.includes(name)) {
      report(
        "IDB_AUTOINCREMENT_NOT_ON_KEY_FIELD",
        `${label} requests autoincrement but is not the model's primary key. IndexedDB only generates primary keys.`,
        at
      );
    } else if (keys.length > 1) {
      report(
        "IDB_AUTOINCREMENT_ON_COMPOUND_KEY",
        `${label} requests autoincrement on a compound primary key. IndexedDB requires a single-field key for autoincrement.`,
        at
      );
    } else if (model.fields.find((field) => field.name === name)?.codecId !== "idb/int32@1") {
      report(
        "IDB_AUTOINCREMENT_NOT_INT",
        `${label} requests autoincrement but is not Int. IndexedDB key generators only produce numbers.`,
        at
      );
    }
  }
}

/** Validate excluded source fields before checking relations that depend on them. */
function validateExcludedFields(model: IdbModelNode, report: Report): void {
  const at = ["models", model.modelName];
  for (const name of model.exclusions?.fields ?? []) {
    if (model.exclusions?.relationFields.includes(name)) {
      report(
        "IDB_EXCLUDE_ON_RELATION_FIELD_UNSUPPORTED",
        `Field "${model.modelName}.${name}" is a relation field and cannot be marked @idb.exclude directly. Exclude the target model with @@idb.exclude to drop the relation, or exclude a plain scalar field.`,
        [...at, "fields", name]
      );
    } else if (!model.exclusions?.declaredFields.includes(name)) {
      report("IDB_UNKNOWN_EXCLUDED_FIELD", `Model "${model.modelName}" excludes unknown field "${name}".`, [
        ...at,
        "fields",
        name,
      ]);
    }
  }
}

/** An excluded owning relation cannot supply the join for a backrelation. */
function relationHasExclusion(
  model: IdbModelNode,
  relation: IdbRelationNode,
  definition: IdbContractDefinition
): boolean {
  const target = definition.models.find((node) => node.modelName === relation.to);
  return (
    model.exclusions?.fields.includes(relation.name) === true ||
    relation.localFields.some((name) => model.exclusions?.fields.includes(name)) ||
    relation.targetFields.some((name) => target?.exclusions?.fields.includes(name))
  );
}

/** Find a backrelation's declared owning side by its join coordinates. */
function excludedInverse(model: IdbModelNode, relation: IdbRelationNode, definition: IdbContractDefinition): boolean {
  if (relation.cardinality !== "1:N") return false;
  const target = definition.models.find((node) => node.modelName === relation.to);
  return (
    target?.relations.some(
      (inverse) =>
        inverse.cardinality !== "1:N" &&
        inverse.to === model.modelName &&
        sameJoinPairs(inverse.localFields, inverse.targetFields, relation.targetFields, relation.localFields) &&
        relationHasExclusion(target, inverse, definition)
    ) === true
  );
}

/** Validate relation field exclusions and conflicting reciprocal referential actions. */
function validateRelations(model: IdbModelNode, definition: IdbContractDefinition, report: Report): void {
  const at = ["models", model.modelName];
  for (const relation of model.relations) {
    const target = definition.models.find((node) => node.modelName === relation.to);
    const relationAt = [...at, "fields", relation.name];
    if (relation.unresolvedBackrelation || excludedInverse(model, relation, definition)) continue;
    if (relation.localFields.some((name) => model.exclusions?.fields.includes(name))) {
      report(
        "IDB_CANNOT_EXCLUDE_RELATION_FIELD",
        `Relation "${model.modelName}.${relation.name}" uses a local field that cannot be excluded independently. Remove the exclusion or exclude the whole model.`,
        relationAt
      );
    }
    if (relation.targetFields.some((name) => target?.exclusions?.fields.includes(name))) {
      report(
        "IDB_CANNOT_EXCLUDE_RELATION_FIELD",
        `Relation "${model.modelName}.${relation.name}" references excluded field on "${relation.to}". Remove the exclusion or exclude the whole model.`,
        relationAt
      );
    }
    if (relation.localFields.length === 0 || relation.localFields.length !== relation.targetFields.length) {
      report(
        "IDB_INVALID_RELATION",
        `Relation "${model.modelName}.${relation.name}" must declare the same non-zero number of local and target fields.`,
        relationAt
      );
    }
    for (const inverse of target?.relations ?? []) {
      if (
        inverse.to !== model.modelName ||
        (relation.cardinality === "N:1" && inverse.cardinality === "N:1") ||
        !sameJoinPairs(inverse.localFields, inverse.targetFields, relation.targetFields, relation.localFields)
      )
        continue;
      // Report each pair once so reciprocal declarations do not duplicate the same error.
      if (definition.models.indexOf(model) > definition.models.indexOf(target!)) continue;
      if (model === target && model.relations.indexOf(relation) >= model.relations.indexOf(inverse)) continue;
      for (const kind of ["onDelete", "onUpdate"] as const) {
        if (relation[kind] !== undefined && inverse[kind] !== undefined)
          report(
            "IDB_CONFLICTING_RELATION_ACTIONS",
            `Relation "${model.modelName}.${relation.name}" and its reciprocal "${relation.to}.${inverse.name}" both declare "${kind}". Declare the action on one side only.`,
            relationAt
          );
      }
    }
  }
}

/** Preserve actionable backrelation errors when projection invalidates their owning relation. */
function validateBackrelations(model: IdbModelNode, definition: IdbContractDefinition, report: Report): void {
  for (const relation of model.relations) {
    if (!relation.unresolvedBackrelation && !excludedInverse(model, relation, definition)) continue;
    report(
      "IDB_UNRESOLVED_BACKRELATION",
      `Backrelation field "${model.modelName}.${relation.name}" (list of ${relation.to}) has no matching @relation in "${relation.to}" pointing to "${model.modelName}". Add @relation(fields: [...], references: [...]) to the FK field in "${relation.to}".`,
      ["models", model.modelName, "fields", relation.name]
    );
  }
}

/**
 * Why `name` can't be a key in the emitted contract, if it can't. JavaScript
 * reads `__proto__` as an object's prototype rather than as a key, and
 * contract canonicalization drops every key named `_generated`, so a model,
 * field, relation, store, index or enum with either name would vanish from
 * the contract.
 */
function reservedNameReason(name: string): string | undefined {
  if (name === "__proto__") return "JavaScript reads it as an object's prototype rather than as a key";
  if (name === "_generated") return "contract emission drops every key with that name";
  return undefined;
}

/** The store the client always creates to hold the contract marker, so no model can use its name. */
const MARKER_STORE_NAME = "_prisma_next_marker";

/** Refuse names the emitted contract can't keep as keys, and the store name the client keeps for its marker. */
function validateReservedNames(definition: IdbContractDefinition, report: Report): void {
  const check = (label: string, name: string, at: IdbDefinitionPath) => {
    const reason = reservedNameReason(name);
    if (reason !== undefined)
      report("IDB_RESERVED_NAME", `${label} "${name}" can't be used: ${reason}. Rename it.`, at);
  };
  for (const node of definition.enums) {
    check("Enum name", node.name, ["enums", node.name]);
    for (const member of node.members) {
      check(`Enum "${node.name}" member name`, member.name, ["enums", node.name, "members", member.name]);
    }
  }
  for (const model of definition.models) {
    const at = ["models", model.modelName];
    check("Model name", model.modelName, at);
    check(`Model "${model.modelName}" store name`, model.storeName, [...at, "storeName"]);
    if (model.storeName === MARKER_STORE_NAME) {
      report(
        "IDB_RESERVED_NAME",
        `Model "${model.modelName}" store name "${model.storeName}" can't be used: the client keeps its contract marker in a store with that name. Rename it.`,
        [...at, "storeName"]
      );
    }
    // Client projection removes excluded scalar fields but keeps their declared names.
    const fieldNames = new Set(model.fields.map((field) => field.name));
    if (model.exclusions) {
      const excludedFields = new Set(model.exclusions.fields);
      for (const name of model.exclusions.relationFields) excludedFields.delete(name);
      for (const name of model.exclusions.declaredFields) {
        if (excludedFields.has(name)) fieldNames.add(name);
      }
    }
    for (const name of fieldNames) check(`Model "${model.modelName}" field name`, name, [...at, "fields", name]);
    for (const relation of model.relations) {
      check(`Model "${model.modelName}" relation name`, relation.name, [...at, "relations", relation.name]);
    }
    for (const index of model.indexes)
      check(`Model "${model.modelName}" index name`, index.name, [...at, "indexes", index.name]);
  }
}

/** Check shared IDB authoring rules without assembling a contract or stopping at the first error. */
export function validateIdbContractDefinition(definition: IdbContractDefinition): IdbDiagnostic[] {
  const diagnostics: IdbDiagnostic[] = [];
  const report: Report = (code, message, at) => diagnostics.push({ code, message, at });
  validateReservedNames(definition, report);
  validateEnums(definition, report);
  for (const model of definition.models) {
    validateKeys(model, report);
    validateIndexes(model, report);
    validateAutoIncrement(model, report);
    for (const field of model.fields) validateField(model, field, definition, report);
    validateExcludedFields(model, report);
    validateRelations(model, definition, report);
  }
  for (const model of definition.models) validateBackrelations(model, definition, report);
  validateStoreNames(definition, report);
  return diagnostics;
}
