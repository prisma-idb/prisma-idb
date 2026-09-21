/**
 * Applies `contract.execution.mutations.defaults` (ADR 158) during a
 * create/update — IDB's equivalent of the SQL family's
 * `ExecutionContext.applyMutationDefaults`.
 *
 * Semantics mirror the SQL reference implementation:
 * - a caller-provided value always wins over a default;
 * - an empty update patch skips every `onUpdate` default (no write ⇒ no
 *   `@updatedAt` advance);
 * - `timestampNow`'s value is cached per call so a whole top-level mutation
 *   call (e.g. a `createAll()` batch) shares one generated value across
 *   every row it backs, matching its `'query'`-stability in SQL. Every other
 *   generator (`literal`, `uuidv4`, `uuidv7`, `cuid2`) is deliberately *not*
 *   cached — an id generator must produce a fresh, unique value per
 *   resolution (both across rows in a batch and across distinct defaulted
 *   fields on the same row), and a cache keyed only by generator id would
 *   otherwise leak one field's/row's value onto the next.
 */
import type { ExecutionMutationDefault, ExecutionMutationDefaultValue } from "@prisma/orm-framework/contract/types";
import { generateId } from "@prisma/orm-framework/ids/runtime";
import type { IdbMutationDefaultGeneratorId } from "@prisma-idb/target-idb/pack";

/** Per-top-level-mutation-call cache, keyed by generator id. Create one with {@link createMutationDefaultsCache}. */
export type MutationDefaultsCache = Map<string, unknown>;

export function createMutationDefaultsCache(): MutationDefaultsCache {
  return new Map();
}

/** Generator ids whose value is shared across an entire top-level call. Every other id always regenerates. */
const CACHEABLE_GENERATOR_IDS: ReadonlySet<IdbMutationDefaultGeneratorId> = new Set(["timestampNow"]);

function computeGeneratedValue(spec: ExecutionMutationDefaultValue): unknown {
  const id = spec.id as IdbMutationDefaultGeneratorId;
  switch (id) {
    case "timestampNow":
      return new Date();
    case "literal":
      return spec.params?.["value"];
    case "uuidv4":
    case "uuidv7":
    case "cuid2":
      return generateId(spec.params !== undefined ? { id, params: spec.params } : { id });
    default: {
      const _exhaustive: never = id;
      throw new Error(`Unknown mutation-default generator id "${String(_exhaustive)}"`);
    }
  }
}

function resolveGeneratedValue(spec: ExecutionMutationDefaultValue, cache: MutationDefaultsCache): unknown {
  const id = spec.id as IdbMutationDefaultGeneratorId;
  if (!CACHEABLE_GENERATOR_IDS.has(id)) return computeGeneratedValue(spec);
  const cached = cache.get(id);
  if (cached !== undefined) return cached;
  const value = computeGeneratedValue(spec);
  cache.set(id, value);
  return value;
}

/**
 * Fills in every column with an `onCreate` default that `data` doesn't
 * already set. Returns `data` unchanged (same reference) if there's nothing
 * to apply.
 */
export function applyCreateDefaults(
  defaults: readonly ExecutionMutationDefault[] | undefined,
  storeName: string,
  data: Record<string, unknown>,
  cache: MutationDefaultsCache
): Record<string, unknown> {
  if (!defaults || defaults.length === 0) return data;
  let result = data;
  for (const d of defaults) {
    if (d.ref.table !== storeName || !d.onCreate) continue;
    if (result[d.ref.column] !== undefined) continue;
    if (result === data) result = { ...data };
    result[d.ref.column] = resolveGeneratedValue(d.onCreate, cache);
  }
  return result;
}

/**
 * Fills in every column with an `onUpdate` default that `patch` doesn't
 * already set. A patch with no defined values (empty, or every field
 * explicitly `undefined`) is returned unchanged — no write means no default
 * should fire either (matches SQL's "empty update payloads skip onUpdate
 * defaults" rule).
 */
export function applyUpdateDefaults(
  defaults: readonly ExecutionMutationDefault[] | undefined,
  storeName: string,
  patch: Record<string, unknown>,
  cache: MutationDefaultsCache
): Record<string, unknown> {
  if (Object.values(patch).every((v) => v === undefined)) return patch;
  if (!defaults || defaults.length === 0) return patch;
  let result = patch;
  for (const d of defaults) {
    if (d.ref.table !== storeName || !d.onUpdate) continue;
    if (result[d.ref.column] !== undefined) continue;
    if (result === patch) result = { ...patch };
    result[d.ref.column] = resolveGeneratedValue(d.onUpdate, cache);
  }
  return result;
}
