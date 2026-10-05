import type { IdbFieldFilter, IdbFilterExpr } from "@prisma-idb/adapter-idb/runtime";
import type { IdbKeyRangeDescriptor, IdbScanDirection } from "@prisma-idb/driver-idb/runtime";
import { compareFieldValues, isValidIdbKey, keyEquals } from "@prisma-idb/target-idb/runtime";
import type { CatalogField, CatalogSource, QueryCatalog } from "./catalog";

/** Query inputs relevant to access selection. Pagination is applied by the caller. */
export interface PlanRequest {
  readonly where?: IdbFilterExpr;
  readonly orderBy?: Readonly<Record<string, "asc" | "desc">>;
  readonly take?: number;
  /** Relation predicates are evaluated outside the scalar filter AST. */
  readonly hasRelationFilter?: boolean;
}

/**
 * Disjoint driver-compatible ranges on one source, sorted by ascending key.
 * An absent range means all keys. Reverse the range sequence for `prev` traversal.
 */
export type QueryAccess =
  | { readonly kind: "full" }
  | { readonly kind: "empty" }
  | {
      readonly kind: "ranges";
      readonly source: CatalogSource;
      readonly ranges: readonly (IdbKeyRangeDescriptor | undefined)[];
    };

/** The access is a superset of matches. Always reapply the original filter. */
export interface LogicalPlan {
  readonly access: QueryAccess;
  readonly exact: boolean;
  /** Present only when source traversal satisfies the requested single-field order. */
  readonly direction?: IdbScanDirection;
}

interface Bound {
  readonly value: IDBValidKey;
  readonly open: boolean;
}
interface Constraint {
  points?: IDBValidKey[];
  lower?: Bound;
  upper?: Bound;
  consumed: number;
  startsWith?: boolean;
  rejectsNonKeys?: boolean;
}
interface Candidate {
  source: CatalogSource;
  ranges: (IdbKeyRangeDescriptor | undefined)[];
  cost: number;
  consumed: number;
  declaration: number;
}
interface Normalized {
  atoms: IdbFieldFilter[];
  residual: number;
  excluded: boolean;
  empty: boolean;
}

// These encoders also accept non-keys, so index coverage needs a rejecting predicate.
const KEY_PARTIAL_CODECS = new Set(["idb/double@1", "idb/date@1"]);

const KEY_CODECS = new Set([
  "idb/string@1",
  "idb/int32@1",
  "idb/double@1",
  "idb/date@1",
  "idb/decimal@1",
  "idb/bytes@1",
]);

/** Choose the cheapest safe access without opening IndexedDB or probing cardinality. */
export function planQuery(catalog: QueryCatalog, request: PlanRequest): LogicalPlan {
  const normalized = normalize(request.where);
  if (normalized.empty) return { access: { kind: "empty" }, exact: true };
  const orders = Object.entries(request.orderBy ?? {});
  if (normalized.excluded || request.hasRelationFilter || orders.length > 1) return full(false);

  const constraints = new Map<string, Constraint>();
  for (const atom of normalized.atoms) {
    let constraint = constraints.get(atom.field);
    if (!constraint) {
      constraint = { consumed: 0 };
      constraints.set(atom.field, constraint);
    }
    addAtom(constraint, atom, catalog.fields[atom.field]);
  }
  for (const [name, constraint] of constraints) {
    // Inclusive comparisons can match NaN and invalid dates, which indexes omit.
    if (keyPartial(catalog.fields[name]) && !constraint.rejectsNonKeys) {
      delete constraint.lower;
      delete constraint.upper;
      constraint.consumed = 0;
    }
    if (contradictory(constraint)) return { access: { kind: "empty" }, exact: true };
  }

  const sources = [catalog.primaryKey, ...catalog.indexes];
  const candidates = sources.flatMap((source, declaration) => {
    const candidate = filteringCandidate(catalog, source, constraints, declaration);
    return candidate ? [candidate] : [];
  });
  candidates.sort(
    (a, b) =>
      a.cost - b.cost ||
      a.ranges.length - b.ranges.length ||
      Number(a.source.indexName !== undefined) - Number(b.source.indexName !== undefined) ||
      a.declaration - b.declaration
  );
  let selected = candidates[0];
  let direction: IdbScanDirection | undefined;
  if (orders.length === 1 && request.take !== undefined) {
    const [field, order] = orders[0]!;
    if (selected) {
      if (singleFieldSource(selected.source, field)) direction = order === "asc" ? "next" : "prev";
    } else {
      const ordering = sources.find(
        (source) => !source.multiEntry && singleFieldSource(source, field) && completeKeyField(catalog.fields[field])
      );
      if (ordering) {
        selected = {
          source: ordering,
          ranges: [undefined],
          cost: 6,
          consumed: 0,
          declaration: sources.indexOf(ordering),
        };
        direction = order === "asc" ? "next" : "prev";
      }
    }
  }
  if (!selected) {
    const partialOrder = orders.length === 1 && request.take !== undefined && keyPartial(catalog.fields[orders[0]![0]]);
    return full(normalized.atoms.length + normalized.residual === 0 && !partialOrder);
  }
  return {
    access: { kind: "ranges", source: selected.source, ranges: selected.ranges },
    exact: selected.consumed === normalized.atoms.length && normalized.residual === 0,
    ...(direction === undefined ? {} : { direction }),
  };
}

function full(exact: boolean): LogicalPlan {
  return { access: { kind: "full" }, exact };
}

function normalize(where: IdbFilterExpr | undefined): Normalized {
  const result: Normalized = { atoms: [], residual: 0, excluded: false, empty: false };
  function visit(expr: IdbFilterExpr): void {
    switch (expr.kind) {
      case "field":
        if (expr.op === "in" && (!Array.isArray(expr.value) || expr.value.length === 0)) result.empty = true;
        result.atoms.push(expr);
        break;
      case "and":
        expr.exprs.forEach(visit);
        break;
      case "or": {
        if (expr.exprs.length === 0) {
          result.empty = true;
          break;
        }
        const branches = expr.exprs;
        const first = branches[0]!;
        if (
          first.kind !== "field" ||
          !branches.every(
            (branch) =>
              branch.kind === "field" && branch.field === first.field && (branch.op === "eq" || branch.op === "in")
          )
        ) {
          result.excluded = true;
          break;
        }
        const values = branches.flatMap((branch) => {
          const atom = branch as IdbFieldFilter;
          return atom.op === "eq" ? [atom.value] : Array.isArray(atom.value) ? atom.value : [];
        });
        visit({ kind: "field", field: first.field, op: "in", value: values });
        break;
      }
      case "not":
        result.excluded = true;
        break;
      case "null-check":
        result.residual++;
        break;
    }
  }
  if (where) visit(where);
  return result;
}

function keyTyped(field: CatalogField | undefined): boolean {
  return field !== undefined && !field.collection && KEY_CODECS.has(field.codecId ?? "");
}
function keyPartial(field: CatalogField | undefined): boolean {
  return KEY_PARTIAL_CODECS.has(field?.codecId ?? "");
}
function completeKeyField(field: CatalogField | undefined, constraint?: Constraint): boolean {
  return keyTyped(field) && field?.nullable === false && (!keyPartial(field) || constraint?.rejectsNonKeys === true);
}
function singleFieldSource(source: CatalogSource, field: string): boolean {
  return source.fields.length === 1 && source.fields[0] === field;
}

function addAtom(constraint: Constraint, atom: IdbFieldFilter, field: CatalogField | undefined): void {
  if (atom.op === "eq" || atom.op === "in") {
    const values: unknown[] = atom.op === "eq" ? [atom.value] : Array.isArray(atom.value) ? atom.value : [];
    if (!values.every(isValidIdbKey)) return;
    const points = uniqueKeys(values);
    constraint.points =
      constraint.points === undefined
        ? points
        : constraint.points.filter((point) => points.some((value) => keyEquals(point, value)));
    constraint.rejectsNonKeys = true;
    constraint.consumed++;
    return;
  }
  if (!keyTyped(field)) return;
  if (atom.op === "startsWith") {
    if (field?.codecId !== "idb/string@1" || typeof atom.value !== "string") return;
    intersectBound(constraint, "lower", { value: atom.value, open: false });
    const upper = stringSuccessor(atom.value);
    if (upper !== undefined) intersectBound(constraint, "upper", { value: upper, open: true });
    constraint.startsWith = true;
    constraint.consumed++;
  } else if (["gt", "gte", "lt", "lte"].includes(atom.op) && isValidIdbKey(atom.value)) {
    const side = atom.op === "gt" || atom.op === "gte" ? "lower" : "upper";
    const strict = atom.op === "gt" || atom.op === "lt";
    intersectBound(constraint, side, { value: atom.value, open: strict });
    if (strict) constraint.rejectsNonKeys = true;
    constraint.consumed++;
  }
}

function uniqueKeys(values: IDBValidKey[]): IDBValidKey[] {
  return values
    .filter((value, i) => !values.slice(0, i).some((previous) => keyEquals(previous, value)))
    .sort(compareFieldValues);
}
function intersectBound(constraint: Constraint, side: "lower" | "upper", bound: Bound): void {
  const previous = constraint[side];
  const comparison = previous === undefined ? 0 : compareFieldValues(bound.value, previous.value);
  if (!previous || (side === "lower" ? comparison > 0 : comparison < 0) || (comparison === 0 && bound.open)) {
    constraint[side] = bound;
  }
}
function insideBounds(value: IDBValidKey, constraint: Constraint): boolean {
  const lower = constraint.lower;
  const upper = constraint.upper;
  if (lower && (compareFieldValues(value, lower.value) < 0 || (lower.open && keyEquals(value, lower.value))))
    return false;
  if (upper && (compareFieldValues(value, upper.value) > 0 || (upper.open && keyEquals(value, upper.value))))
    return false;
  return true;
}
function contradictory(constraint: Constraint): boolean {
  if (constraint.points) {
    constraint.points = constraint.points.filter((value) => insideBounds(value, constraint));
    return constraint.points.length === 0;
  }
  if (!constraint.lower || !constraint.upper) return false;
  const comparison = compareFieldValues(constraint.lower.value, constraint.upper.value);
  return comparison > 0 || (comparison === 0 && (constraint.lower.open || constraint.upper.open));
}

function filteringCandidate(
  catalog: QueryCatalog,
  source: CatalogSource,
  constraints: ReadonlyMap<string, Constraint>,
  declaration: number
): Candidate | undefined {
  if (source.multiEntry || source.fields.length === 0) return undefined;
  if (source.fields.some((name) => keyPartial(catalog.fields[name]) && !constraints.get(name)?.rejectsNonKeys))
    return undefined;
  let prefixes: IDBValidKey[][] = [[]];
  let consumed = 0;
  let position = 0;
  while (position < source.fields.length) {
    const constraint = constraints.get(source.fields[position]!);
    if (constraint?.points === undefined) break;
    // Avoid allocating an unbounded Cartesian product. A full scan is always safe.
    if (prefixes.length * constraint.points.length > 1024) return undefined;
    prefixes = prefixes.flatMap((prefix) => constraint.points!.map((point) => [...prefix, point]));
    consumed += constraint.consumed;
    position++;
  }
  const constraint = constraints.get(source.fields[position] ?? "");
  const hasRange = constraint !== undefined && (constraint.lower !== undefined || constraint.upper !== undefined);
  if (position === 0 && !hasRange) return undefined;
  const used = position + Number(hasRange);
  if (!source.fields.slice(used).every((field) => completeKeyField(catalog.fields[field], constraints.get(field))))
    return undefined;
  const compound = typeof source.keyPath !== "string";
  if (position === source.fields.length) {
    return {
      source,
      ranges: prefixes.map((prefix) => ({ kind: "only", key: compound ? prefix : prefix[0]! })),
      cost: source.indexName !== undefined && source.unique ? 0 : source.indexName === undefined ? 1 : 2,
      consumed,
      declaration,
    };
  }
  if (hasRange) consumed += constraint.consumed;
  const ranges = prefixes.map((prefix) =>
    compound ? compoundRange(prefix, constraint, source.fields.length - used) : scalarRange(constraint!)
  );
  // A literal outside the stored scalar type can sort above the compound sentinel.
  if (
    ranges.some(
      (range) =>
        range.kind === "bound" &&
        (compareFieldValues(range.lower, range.upper) > 0 ||
          (keyEquals(range.lower, range.upper) && (range.lowerOpen || range.upperOpen)))
    )
  )
    return undefined;
  const cost = hasRange ? (constraint.lower && constraint.upper && !constraint.startsWith ? 4 : 5) : 3;
  return { source, ranges, cost, consumed, declaration };
}

function scalarRange(constraint: Constraint): IdbKeyRangeDescriptor {
  if (constraint.lower && constraint.upper)
    return {
      kind: "bound",
      lower: constraint.lower.value,
      upper: constraint.upper.value,
      lowerOpen: constraint.lower.open,
      upperOpen: constraint.upper.open,
    };
  if (constraint.lower) return { kind: "lower", key: constraint.lower.value, open: constraint.lower.open };
  return { kind: "upper", key: constraint.upper!.value, open: constraint.upper!.open };
}

function compoundRange(
  prefix: IDBValidKey[],
  constraint: Constraint | undefined,
  trailing: number
): IdbKeyRangeDescriptor {
  const lower = constraint?.lower;
  const upper = constraint?.upper;
  // [] sorts above every scalar key codec. Nested-array codecs are excluded for trailing fields.
  const lowerKey = lower
    ? [...prefix, lower.value, ...(lower.open && trailing > 0 ? [[]] : [])]
    : prefix.length
      ? prefix
      : [-Infinity];
  const upperKey = upper ? [...prefix, upper.value, ...(!upper.open && trailing > 0 ? [[]] : [])] : [...prefix, []];
  return {
    kind: "bound",
    lower: lowerKey,
    upper: upperKey,
    lowerOpen: lower?.open ?? false,
    upperOpen: upper ? upper.open || trailing > 0 : true,
  };
}

function stringSuccessor(prefix: string): string | undefined {
  for (let i = prefix.length - 1; i >= 0; i--) {
    const code = prefix.charCodeAt(i);
    if (code < 0xffff) return prefix.slice(0, i) + String.fromCharCode(code + 1);
  }
  return undefined;
}
