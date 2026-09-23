import type { StorageBase } from "@prisma/orm-framework/contract/types";

/**
 * Full storage shape for an IDB contract.
 *
 * Extends the framework {@link StorageBase} to carry the `storageHash` alongside
 * IDB-specific data: a map of object store names to their {@link IdbStoreDefinition}s.
 *
 * @template THash - Literal hash string embedded in the `storageHash` branded type.
 */
export type IdbStorage<THash extends string = string> = StorageBase<THash> & {
  readonly stores: Record<string, IdbStoreDefinition>;
};

/**
 * A store or index `keyPath`: a single field name, or (for a compound primary
 * key / compound secondary index) an ordered list of field names. Mirrors
 * `IDBObjectStore.createObjectStore()`'s/`createIndex()`'s native `keyPath`
 * parameter, which accepts either a string or a sequence — array `keyPath` is
 * standard IndexedDB, not an extension (Phase 9.1/9.2).
 *
 * Field order is significant and is NOT normalized anywhere in this stack:
 * `['a','b']` and `['b','a']` are different keys with different sort orders.
 * Every construction/comparison site must preserve declaration order.
 */
export type IdbKeyPath = string | readonly string[];

/**
 * Normalizes a {@link IdbKeyPath} to an ordered list of field names — `"id"`
 * becomes `["id"]`, `["a","b"]` passes through unchanged. Shared by every
 * layer that needs to iterate a key's member fields uniformly regardless of
 * whether the model has a single-field or compound key.
 */
export function keyPathFields(keyPath: IdbKeyPath): readonly string[] {
  return typeof keyPath === "string" ? [keyPath] : keyPath;
}

/**
 * Structural equality between two {@link IdbKeyPath} values — plain `!==`
 * is wrong for the array case (reference inequality, not content equality).
 * Order-sensitive: `['a','b']` and `['b','a']` are NOT equal.
 *
 * A bare string and a 1-element array with the same field name are
 * deliberately NOT equal (`"id"` !== `["id"]`), even though
 * {@link keyPathFields} normalizes both to the same member-field list for
 * *extraction* purposes. `createObjectStore(name, {keyPath: "id"})` and
 * `createObjectStore(name, {keyPath: ["id"]})` are genuinely different native
 * IDB configurations — the latter always requires an array `IDBValidKey`
 * (`store.get(["x"])`, not `store.get("x")`) — so a migration/schema-verify
 * diff between them is a real, actionable mismatch, not a false positive to
 * suppress.
 */
export function keyPathEquals(a: IdbKeyPath, b: IdbKeyPath): boolean {
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const af = keyPathFields(a);
  const bf = keyPathFields(b);
  return af.length === bf.length && af.every((field, i) => field === bf[i]);
}

/**
 * Configuration for a single IndexedDB object store.
 *
 * Mirrors the options accepted by `IDBDatabase.createObjectStore()`:
 * - `keyPath` — the property path used as the primary key (e.g. `"id"`, or
 *   `["a", "b"]` for a compound primary key — see {@link IdbKeyPath}).
 * - `autoIncrement` — when `true` IDB auto-generates integer keys. Omit (or `false`)
 *   for client-generated keys (UUID / CUID), which is the common case for syncable models.
 *   Native IDB rejects `autoIncrement: true` combined with an array `keyPath`
 *   (`InvalidAccessError`) — a compound key can never be auto-generated.
 * - `indexes` — named secondary indexes on this store.
 */
export type IdbStoreDefinition = {
  readonly keyPath: IdbKeyPath;
  readonly autoIncrement?: boolean;
  readonly indexes?: Record<string, IdbIndexDefinition>;
};

/**
 * Configuration for a single secondary index on an object store.
 *
 * Mirrors the options accepted by `IDBObjectStore.createIndex()`. `keyPath`
 * may be a compound (array) key path for a multi-field index — see
 * {@link IdbKeyPath}. Native IDB rejects `multiEntry: true` combined with an
 * array `keyPath` (`InvalidAccessError`) — `multiEntry` and compound indexes
 * are distinct, mutually exclusive features.
 */
export type IdbIndexDefinition = {
  readonly keyPath: IdbKeyPath;
  readonly unique: boolean;
  readonly multiEntry?: boolean;
};

/** Referential action executed on child rows when a parent row is deleted or updated. */
export type IdbReferentialAction = "cascade" | "setNull" | "setDefault" | "restrict" | "noAction";

/**
 * Mutation-default generator ids IDB recognizes in `contract.execution.mutations.defaults`.
 *
 * - `"timestampNow"` — `new Date()`. Backs `temporal.updatedAt()` and bare
 *   `@updatedAt` (onCreate + onUpdate) and `@default(now())` (onCreate only).
 * - `"literal"` — echoes `params.value` verbatim. Backs `@default(<literal>)`.
 *   IDB has no storage-plane default slot (no server to render one), so even
 *   a literal default has to be produced by this same execution-plane
 *   mechanism.
 * - `"uuidv4"` / `"uuidv7"` / `"cuid2"` — backed by Prisma ORM's shared ID helpers
 *   (the same shared framework ID-generation package the SQL family's own
 *   presets use). Back `@default(uuid())` / `@default(uuid(7))` / `@default(cuid())`.
 *
 * Kept as a named union — rather than inlining string literals at each use
 * site — so an id can't drift between the PSL interpreter (which writes it)
 * and the runtime mutation-defaults resolver (which reads it, exhaustively
 * switching over this type).
 */
export type IdbMutationDefaultGeneratorId = "timestampNow" | "literal" | "uuidv4" | "uuidv7" | "cuid2";

/**
 * Per-relation storage metadata attached to {@link IdbModelStorage}.
 *
 * `onUpdate`'s default (when omitted) is `'cascade'`, unlike `onDelete`'s
 * `'restrict'` default — matching Prisma's own documented behavior:
 * propagating a changed referenced value to children is normally safe,
 * unlike deleting the row those children point to.
 */
export type IdbRelationStorage = {
  readonly onDelete?: IdbReferentialAction; // default: 'restrict'
  readonly onUpdate?: IdbReferentialAction; // default: 'cascade'
};

/**
 * Per-model storage metadata stored in `contract.models[ModelName].storage`.
 *
 * Tells the runtime (and the generated client) which object store owns this model
 * and which field is its primary key. `relations` carries per-relation enforcement
 * metadata (e.g. `onDelete`) mirroring the SQL target's FK constraint metadata.
 * `fieldDefaults` carries literal `@default(...)` values, keyed by field name —
 * feeds the `setDefault` referential action (a child's FK field is reset to its
 * own declared default, not the parent's). Only ever populated from a *literal*
 * default (string/number/boolean) — never a generator like `uuid()`/`now()`,
 * matching Prisma's own rule that `SetDefault` may only target a scalar default.
 */
export type IdbModelStorage = {
  readonly storeName: string;
  readonly keyPath: IdbKeyPath;
  readonly relations?: Record<string, IdbRelationStorage>;
  readonly fieldDefaults?: Record<string, string | number | boolean>;
};

/**
 * Type-maps structure for IDB contracts.
 *
 * IDB has no SQL-style operation types or query-operation types — those slots are
 * fixed to `Record<string, never>`. Only codec types and field I/O types vary.
 *
 * @template TCodecTypes          - Codec input/output pairs keyed by codec ID.
 * @template TFieldOutputTypes    - Per-model, per-field TypeScript output types.
 * @template TFieldInputTypes     - Per-model, per-field TypeScript input types.
 */
export type IdbTypeMaps<
  TCodecTypes extends Record<string, { output: unknown }> = Record<string, never>,
  TFieldOutputTypes extends Record<string, Record<string, unknown>> = Record<string, never>,
  TFieldInputTypes extends Record<string, Record<string, unknown>> = Record<string, never>,
> = {
  readonly codecTypes: TCodecTypes;
  readonly operationTypes: Record<string, never>;
  readonly queryOperationTypes: Record<string, never>;
  readonly fieldOutputTypes: TFieldOutputTypes;
  readonly fieldInputTypes: TFieldInputTypes;
};

/** @internal Phantom key used to attach {@link IdbTypeMaps} to a contract without widening the contract shape. */
type IdbTypeMapsPhantomKey = "__@prisma-idb/family-idb/typeMaps@__";

/**
 * Intersects a contract type with its type-maps via a phantom property.
 *
 * Mirrors `ContractWithTypeMaps` from `@prisma/orm-framework/contract/types`. The phantom
 * property is optional and carries no runtime value — it exists solely so that
 * TypeScript-level utilities can extract `TTypeMaps` from a `Contract` type parameter.
 *
 * @template TContract  - The base contract type.
 * @template TTypeMaps  - The {@link IdbTypeMaps} instantiation to attach.
 */
export type IdbContractWithTypeMaps<TContract, TTypeMaps> = TContract & {
  readonly [K in IdbTypeMapsPhantomKey]?: TTypeMaps;
};

// ── Type-map extraction helpers ───────────────────────────────────────────────

/**
 * Extract the full {@link IdbTypeMaps} from a contract wrapped with
 * {@link IdbContractWithTypeMaps}. Returns `never` if the contract does not
 * carry type maps (e.g. a plain `Contract<IdbStorage>` without the phantom key).
 */
export type ExtractIdbTypeMaps<TContract> = TContract extends {
  readonly [K in IdbTypeMapsPhantomKey]?: infer TM;
}
  ? TM
  : never;

/**
 * Extract the `fieldOutputTypes` slot from a contract's type maps.
 *
 * Used by the IDB ORM client to resolve per-model, per-field TypeScript output
 * types from the emitted `IdbTypeMaps<CodecTypes, FieldOutputTypes, FieldInputTypes>`.
 */
export type ExtractIdbFieldOutputTypes<TContract> =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- any is used as a wildcard for type inference; the actual constraint is Record<string, { output: unknown }> | Record<string, Record<string, unknown>>
  ExtractIdbTypeMaps<TContract> extends IdbTypeMaps<any, infer FO, any> ? FO : never;

/**
 * Extract the `fieldInputTypes` slot from a contract's type maps.
 *
 * Used by the IDB ORM client to resolve per-model, per-field TypeScript input
 * types (for `create()`, `where()`, etc.).
 */
export type ExtractIdbFieldInputTypes<TContract> =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- any is used as a wildcard for type inference
  ExtractIdbTypeMaps<TContract> extends IdbTypeMaps<any, any, infer FI> ? FI : never;
