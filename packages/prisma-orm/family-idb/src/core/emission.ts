import type { Contract, ContractModel } from "@prisma/orm-framework/contract/types";
import type { EmissionSpi } from "@prisma/orm-framework/components/emission";
import type { IdbModelStorage, IdbStorage } from "@prisma-idb/target-idb/pack";

// ── Serialization utilities ──────────────────────────────────────────────────
// Adapted from Prisma ORM's domain type generation.
// These utilities convert runtime JS values into TypeScript type-literal strings
// that are spliced verbatim into the generated contract.d.ts file.

/**
 * Converts a JavaScript primitive or plain object into a TypeScript type-literal
 * string. Arrays become `readonly [...]` tuples; objects become `{ readonly k: v }`
 * type literals; strings are single-quoted with escaping.
 */
function serializeValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") {
    const escaped = value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    return `'${escaped}'`;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "bigint") return `${value}n`;
  if (Array.isArray(value)) {
    const items = value.map((v) => serializeValue(v)).join(", ");
    return `readonly [${items}]`;
  }
  if (typeof value === "object") {
    const entries: string[] = [];
    for (const [k, v] of Object.entries(value)) {
      entries.push(`readonly ${serializeObjectKey(k)}: ${serializeValue(v)}`);
    }
    return `{ ${entries.join("; ")} }`;
  }
  return "unknown";
}

/**
 * Converts an object key to a safe TypeScript identifier. If the key is already a
 * valid identifier it is returned as-is; otherwise it is wrapped in single-quoted
 * string literal form.
 */
function serializeObjectKey(key: string): string {
  if (/^[$A-Z_a-z][$\w]*$/.test(key)) return key;
  return serializeValue(key);
}

// ── EmissionSpi ───────────────────────────────────────────────────────────────

/**
 * IDB family emission plugin.
 *
 * Registered as `emission` on {@link IdbFamilyDescriptor}. The Prisma 8 emitter
 * calls these methods when generating `contract.d.ts` for any schema that targets the
 * IDB family. Each method returns a raw TypeScript source string that the emitter
 * splices into the generated file at the appropriate location.
 *
 * @see `generateContractDts` in `@prisma/orm-toolchain`.
 */
export const idbEmission = {
  id: "idb",

  /**
   * Serializes the full `storage` section of the contract into a TypeScript type
   * literal. The result is used as the first generic argument of `ContractType<...>`
   * in the generated `contract.d.ts`.
   *
   * For IDB the storage shape is:
   * ```ts
   * { readonly stores: { readonly <storeName>: { readonly keyPath: '...'; ... }; ... };
   *   readonly storageHash: <storageHashTypeName> }
   * ```
   *
   * @param contract            - The resolved Prisma contract.
   * @param storageHashTypeName - Emitter-provided name of the `StorageHash` type alias
   *                              to embed (e.g. `'StorageHash'`).
   */
  generateStorageType(contract: Contract, storageHashTypeName: string): string {
    const storage = contract.storage as IdbStorage;
    const stores: string[] = [];

    for (const [storeName, store] of Object.entries(storage.stores).sort(([a], [b]) => a.localeCompare(b))) {
      const storeParts: string[] = [`readonly keyPath: ${serializeValue(store.keyPath)}`];

      if (store.autoIncrement !== undefined) {
        storeParts.push(`readonly autoIncrement: ${store.autoIncrement}`);
      }

      const indexes = store.indexes ?? {};
      if (Object.keys(indexes).length > 0) {
        const indexEntries: string[] = [];
        for (const [indexName, index] of Object.entries(indexes).sort(([a], [b]) => a.localeCompare(b))) {
          const indexParts = [`readonly keyPath: ${serializeValue(index.keyPath)}`, `readonly unique: ${index.unique}`];
          if (index.multiEntry !== undefined) {
            indexParts.push(`readonly multiEntry: ${index.multiEntry}`);
          }
          indexEntries.push(`readonly ${serializeObjectKey(indexName)}: { ${indexParts.join("; ")} }`);
        }
        storeParts.push(`readonly indexes: { ${indexEntries.join("; ")} }`);
      } else {
        storeParts.push(`readonly indexes: Record<string, never>`);
      }

      stores.push(`readonly ${serializeObjectKey(storeName)}: { ${storeParts.join("; ")} }`);
    }

    const storesType = stores.length > 0 ? `{ ${stores.join("; ")} }` : "Record<string, never>";

    // v0.12.0: StorageBase now requires `namespaces`. Generate the literal type from
    // the contract's storage namespaces so the emitted storage type satisfies StorageBase.
    const nsEntries: string[] = [];
    for (const [nsId, ns] of Object.entries(
      (storage as unknown as { namespaces?: Record<string, { id: string; entries?: Record<string, unknown> }> })
        .namespaces ?? {}
    ).sort(([a], [b]) => a.localeCompare(b))) {
      const entriesObj = ns.entries ?? {};
      const entriesType = Object.keys(entriesObj).length === 0 ? "Record<string, never>" : serializeValue(entriesObj);
      nsEntries.push(
        `readonly ${serializeObjectKey(nsId)}: { readonly id: ${serializeValue(ns.id)}; readonly entries: ${entriesType} }`
      );
    }
    const namespacesType = nsEntries.length > 0 ? `{ ${nsEntries.join("; ")} }` : "Record<string, never>";

    return `{ readonly stores: ${storesType}; readonly namespaces: ${namespacesType}; readonly storageHash: ${storageHashTypeName} }`;
  },

  /**
   * Serializes the per-model storage metadata into a TypeScript type literal.
   * The result is used as the `storage` field of the model's entry in the
   * generated `models` type.
   *
   * For IDB, each model maps to exactly one object store:
   * ```ts
   * { readonly storeName: '<name>'; readonly keyPath: '<field>' }
   * ```
   *
   * @param _modelName - The Prisma model name (unused; provided for API symmetry).
   * @param model      - The resolved `ContractModel` whose `storage` is cast to
   *                     {@link IdbModelStorage}.
   */
  generateModelStorageType(_modelName: string, model: ContractModel): string {
    const idbModel = model as ContractModel<IdbModelStorage>;
    return [
      `{ readonly storeName: ${serializeValue(idbModel.storage.storeName)}`,
      `readonly keyPath: ${serializeValue(idbModel.storage.keyPath)} }`,
    ].join("; ");
  },

  /**
   * Returns the `import type` lines prepended to `contract.d.ts` that bring
   * IDB-family types into scope.
   *
   * Imports {@link IdbContractWithTypeMaps} (the phantom wrapper used by
   * {@link getContractWrapper}) and {@link IdbTypeMaps} (used by
   * {@link getTypeMapsExpression}).
   */
  getFamilyImports(): string[] {
    return ["import type { IdbContractWithTypeMaps, IdbTypeMaps } from '@prisma-idb/target-idb/pack';"];
  },

  /**
   * Returns additional type alias declarations appended to `contract.d.ts`
   * after the codec and operation type aliases.
   *
   * For IDB this exports `LaneCodecTypes` (used by the generated client to
   * look up codec input/output pairs) as a simple alias of the assembled
   * `CodecTypes`. IDB has no query-operation types, so no further aliases
   * are needed.
   */
  getFamilyTypeAliases(): string {
    return "export type LaneCodecTypes = CodecTypes;";
  },

  /**
   * Returns the TypeScript expression for the `TypeMaps<...>` generic
   * instantiation written into `contract.d.ts`.
   *
   * IDB has no operation types or query-operation types, so the expression
   * uses the three-argument form of {@link IdbTypeMaps}.
   */
  getTypeMapsExpression(): string {
    return "IdbTypeMaps<CodecTypes, FieldOutputTypes, FieldInputTypes>";
  },

  /**
   * Returns the final `export type Contract = ...` declaration and convenience
   * re-exports derived from it.
   *
   * @param contractBaseName - Emitter-provided name of the base contract type
   *                           (always `'ContractBase'`).
   * @param typeMapsName     - Emitter-provided name of the assembled TypeMaps type
   *                           (always `'TypeMaps'`).
   */
  getContractWrapper(contractBaseName: string, typeMapsName: string): string {
    return [
      `export type Contract = IdbContractWithTypeMaps<${contractBaseName}, ${typeMapsName}>;`,
      "",
      "export type Stores = Contract['storage']['stores'];",
    ].join("\n");
  },
} as const satisfies EmissionSpi;
